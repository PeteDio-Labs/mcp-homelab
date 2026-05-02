/**
 * mcp-homelab — MCP interface for PeteDio Labs, usable from Claude Code and Codex.
 *
 * Lean set of tools for planning sessions with Claude:
 *   - list_docs / gather_context  → read knowledge/ for context
 *   - save_draft / publish_post   → write blog posts directly from Claude
 *   - send_notification           → manually fire an infra event
 *
 * Agent work (infra investigation, board management, plan breaking,
 * pipeline triggering) is now handled by dedicated agents in agents/.
 * MC Backend dispatches those via POST /run on each agent.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { listDocs } from './tools/listDocs.js';
import { gatherContext, formatContextForWriter } from './tools/gatherContext.js';
import { saveDraft, publishPost } from './tools/saveDraft.js';
import { healthCheck, ragQuery } from './clients/blogApi.js';
import { notify } from './tools/notify.js';
import {
  listAgentsTool,
  listAgentQueueTool,
  getTaskStatusTool,
  runAgentTool,
  watchAgentTool,
  runInfraCheckTool,
  runInfraPlaybookTool,
  runCloudflareTunnelTool,
  runWorkstationTaskTool,
  runWorkstationGrepReplaceTool,
} from './tools/agentControl.js';
import { codeOp, codePlan, type CodeOpAction } from './tools/codeAgent.js';

const DOCS_ROOT = process.env.DOCS_ROOT || '/home/pedro/PeteDio-Labs/knowledge';
const OLLAMA_HOST = process.env.OLLAMA_URL || 'http://192.168.50.59:11434';
const CODER_MODEL = process.env.CODER_MODEL || 'gemma4:e4b';

const server = new McpServer({
  name: 'homelab',
  version: '0.2.0',
});

// ─── Docs Tools ────────────────────────────────────────────────

server.tool(
  'list_docs',
  'List available project documentation files with metadata (last modified, size, category)',
  {
    category: z.enum(['all', 'sessions', 'architecture', 'status']).default('all')
      .describe('Filter by doc category'),
  },
  async ({ category }) => {
    const docs = await listDocs(DOCS_ROOT, category);
    return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
  },
);

server.tool(
  'gather_context',
  'Read project docs (STATUS.md, session summaries, FUTURE-GOALS.md) and produce a structured context summary suitable for blog-agent injection',
  {
    sessionCount: z.number().min(1).max(10).default(2)
      .describe('Number of most recent session summaries to include'),
    includeGoals: z.boolean().default(true)
      .describe('Include FUTURE-GOALS.md goal status summary'),
    format: z.enum(['structured', 'readable']).default('structured')
      .describe('Output format: structured JSON or human-readable text for writer prompt'),
  },
  async ({ sessionCount, includeGoals, format }) => {
    const ctx = await gatherContext(DOCS_ROOT, sessionCount, includeGoals);
    const output = format === 'readable'
      ? formatContextForWriter(ctx)
      : JSON.stringify(ctx, null, 2);
    return { content: [{ type: 'text', text: output }] };
  },
);

// ─── Blog Direct Write Tools ───────────────────────────────────

server.tool(
  'save_draft',
  'Save a blog post directly to the blog-api database (bypasses blog-agent LLM pipeline). Use for Claude-written content.',
  {
    title: z.string().describe('Post title'),
    content: z.string().describe('Post content in markdown'),
    excerpt: z.string().describe('Short excerpt/summary (under 200 chars)'),
    tags: z.array(z.string()).default([]).describe('Tag names for the post'),
    status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT')
      .describe('Post status — DRAFT for review, PUBLISHED to go live'),
  },
  async ({ title, content, excerpt, tags, status }) => {
    const apiUp = await healthCheck();
    if (!apiUp) {
      return { content: [{ type: 'text', text: 'Blog API is unreachable. Is the port-forward running? (kubectl port-forward -n blog-dev svc/blog-api 8080:8080)' }] };
    }

    const result = await saveDraft(title, content, excerpt, tags, status);
    if (result.success && result.post) {
      return {
        content: [{
          type: 'text',
          text: `Post saved!\nID: ${result.post.id}\nSlug: ${result.post.slug}\nStatus: ${result.post.status}\nTags: ${result.post.tags.map((t: { name: string }) => t.name).join(', ')}`,
        }],
      };
    }
    return { content: [{ type: 'text', text: `Failed to save post: ${result.error}` }] };
  },
);

server.tool(
  'publish_post',
  'Publish a draft blog post (changes status from DRAFT to PUBLISHED)',
  {
    id: z.number().describe('Blog post ID to publish'),
  },
  async ({ id }) => {
    const result = await publishPost(id);
    if (result.success && result.post) {
      return { content: [{ type: 'text', text: `Post ${id} published: "${result.post.title}"` }] };
    }
    return { content: [{ type: 'text', text: `Failed to publish post ${id}: ${result.error}` }] };
  },
);

server.tool(
  'rag_query',
  'Semantic search across the blog knowledge base (posts, session summaries, architecture docs). Returns the most relevant chunks by cosine similarity. Requires blog-api port-forward if running locally.',
  {
    query: z.string().describe('Natural language search query'),
    topK: z.number().min(1).max(20).default(5).describe('Number of chunks to return'),
    sourceTypes: z.array(z.enum(['post', 'session', 'doc'])).default(['post', 'session', 'doc'])
      .describe('Limit results by source type: post=published blog posts, session=session summaries, doc=architecture/knowledge docs'),
  },
  async ({ query, topK, sourceTypes }) => {
    const apiUp = await healthCheck();
    if (!apiUp) {
      return { content: [{ type: 'text', text: 'Blog API unreachable. Port-forward needed: kubectl port-forward -n blog-dev svc/blog-api 8080:8080' }] };
    }
    try {
      const { results } = await ragQuery(query, topK, sourceTypes);
      if (!results.length) {
        return { content: [{ type: 'text', text: `No results found for: "${query}"` }] };
      }
      const text = results.map((r, i) =>
        `[${i + 1}] ${r.sourceType}:${r.sourceRef} (similarity: ${r.similarity.toFixed(3)})\n${r.chunkText.slice(0, 600)}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `RAG query error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ─── Notification Tool ──────────────────────────────────────────

server.tool(
  'send_notification',
  'Publish an infrastructure event to the notification service. Useful for manually triggering alerts or testing the pipeline.',
  {
    source: z.enum(['kubernetes', 'proxmox', 'argocd']).describe('Event source'),
    type: z.enum(['deployment', 'pod-failure', 'vm-status', 'lxc-status', 'sync-drift', 'node-status', 'rollout']).describe('Event type'),
    severity: z.enum(['info', 'warning', 'critical']).describe('Event severity'),
    message: z.string().min(1).describe('Human-readable event message'),
    namespace: z.string().optional().describe('K8s namespace (if applicable)'),
    affected_service: z.string().optional().describe('Service name affected'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional key-value metadata'),
  },
  async (params) => {
    const result = await notify(params);
    if (result.success) {
      return { content: [{ type: 'text', text: `Event published (ID: ${result.id})` }] };
    }
    return { content: [{ type: 'text', text: `Failed: ${result.error}` }] };
  },
);

// ─── Agent Visibility Tools (Phase 2) ──────────────────────────

server.tool(
  'list_agents',
  'Show the latest run status for each registered agent. Includes health, last task ID, status, and summary.',
  {},
  async () => {
    const text = await listAgentsTool();
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'list_agent_queue',
  'Show queued and currently running agent tasks across Mission Control. Useful for monitoring workstation-agent and other active runs.',
  {},
  async () => {
    const text = await listAgentQueueTool();
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'get_task_status',
  'Get the full details of a specific agent run by task ID. Returns status, summary, current message, duration, and artifacts if complete.',
  {
    taskId: z.string().describe('Task ID from list_agents or a previous run_agent call'),
  },
  async ({ taskId }) => {
    const text = await getTaskStatusTool(taskId);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_agent',
  'Trigger an allowed agent via Mission Control. Returns a task ID to poll with get_task_status. Allowed agents: knowledge-janitor, ops-investigator, workstation-agent, infra-agent, pm-agent, blog-agent.',
  {
    agentName: z.enum(['knowledge-janitor', 'ops-investigator', 'workstation-agent', 'infra-agent', 'pm-agent', 'blog-agent']).describe('Agent to trigger'),
    input: z.record(z.string(), z.unknown()).default({}).describe('Input payload for the agent'),
  },
  async ({ agentName, input }) => {
    const text = await runAgentTool(agentName, input);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'watch_agent',
  'Poll a specific agent task and return its latest state. Useful as a compact follow-up after run_agent.',
  {
    taskId: z.string().describe('Task ID returned by run_agent or another wrapper tool'),
  },
  async ({ taskId }) => {
    const text = await watchAgentTool(taskId);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_infra_check',
  'Trigger a common read-only infra-agent runbook through Mission Control.',
  {
    mode: z.enum(['health-check', 'check-capacity', 'list-vms', 'list-playbooks', 'get-inventory']).describe('Read-only infrastructure check to run'),
  },
  async ({ mode }) => {
    const text = await runInfraCheckTool(mode);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_infra_playbook',
  'Trigger a common infra-agent playbook workflow through Mission Control. Named runbooks are preferred over raw playbook execution.',
  {
    mode: z.enum(['deploy-local-agents', 'sync-ollama-models', 'update-ollama-service', 'verify-cloudflare-tunnel', 'dry-run-playbook', 'run-playbook'])
      .describe('Named infra runbook or raw playbook mode'),
    playbook: z.string().optional().describe('Required for dry-run-playbook or run-playbook'),
    extraVars: z.string().optional().describe('Optional --extra-vars string'),
    tags: z.string().regex(/^[\w,-]+$/).optional().describe('Optional --tags string (comma-separated)'),
    gated: z.boolean().default(false).describe('Required true for run-playbook and other write flows'),
  },
  async ({ mode, playbook, extraVars, tags, gated }) => {
    const text = await runInfraPlaybookTool(mode, { playbook, extraVars, tags, gated });
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_cloudflare_tunnel',
  'Drive the cloudflare-tunnel Ansible role through infra-agent. Each action runs the matching --tags. Non-gated runs are dry-run only (check + diff); gated runs apply.',
  {
    action: z.enum(['routes', 'dns', 'dns-cleanup', 'verify', 'connector'])
      .describe('routes=push tunnel ingress, dns=create CNAMEs, dns-cleanup=delete removed CNAMEs, verify=read-only checks, connector=update cloudflared container'),
    gated: z.boolean().default(false).describe('Required true to apply; false runs check/diff only (verify is always read-only)'),
  },
  async ({ action, gated }) => {
    const text = await runCloudflareTunnelTool(action, { gated });
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_workstation_task',
  'Trigger a common workstation-agent task through Mission Control using a typed deterministic mode.',
  {
    mode: z.enum(['inspect-repo', 'git-status', 'git-log', 'bun', 'kubectl-get', 'read-file', 'write-file', 'systemd-restart', 'command']).describe('Workstation task mode'),
    workDir: z.string().optional().describe('Working directory for the task'),
    gated: z.boolean().default(false).describe('Enable gated workstation actions'),
    command: z.string().optional().describe('Shell command for command mode'),
    path: z.string().optional().describe('File path for read-file or write-file'),
    content: z.string().optional().describe('Content for write-file'),
    script: z.string().optional().describe('Bun script or args'),
    resource: z.string().optional().describe('kubectl resource selector'),
    unit: z.string().optional().describe('Systemd unit'),
    gitLogCount: z.number().optional().describe('Commit count for git-log'),
  },
  async (args) => {
    const text = await runWorkstationTaskTool(args.mode, args);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_workstation_grep_replace',
  'Codebase-wide find/replace via workstation-agent. Always run with dryRun=true first to inspect the file list. Hard-blocks short or catch-all patterns; refuses apply if >50 files match. Apply requires gated=true.',
  {
    pattern: z.string().min(4).describe('Regex pattern (passed to ripgrep). Must be at least 4 chars; pure-whitespace/dot patterns are blocked.'),
    replacement: z.string().optional().describe('Replacement string for sed (required when dryRun=false)'),
    pathGlob: z.string().optional().describe('Path glob to limit blast radius (defaults to repo root)'),
    dryRun: z.boolean().default(true).describe('When true, only lists matched files. Default true.'),
    gated: z.boolean().default(false).describe('Required true to actually apply replacements'),
  },
  async ({ pattern, replacement, pathGlob, dryRun, gated }) => {
    const text = await runWorkstationGrepReplaceTool({ pattern, replacement, pathGlob, dryRun, gated });
    return { content: [{ type: 'text', text }] };
  },
);

// ─── Code Agent Tools ──────────────────────────────────────────

server.tool(
  'code_op',
  'Execute a single code operation: read/write files, kubectl, git commit/push, or gh CLI. ' +
  'DESTRUCTIVE actions (write_file, kubectl_apply, kubectl_delete, gh_pr_create, git_commit, git_push) require confirmed=true. ' +
  'Risk tiers: 🟢 READ_ONLY (always safe), 🟡 SAFE_MUTATE (kubectl_exec), 🔴 DESTRUCTIVE (requires confirmed).',
  {
    action: z.enum([
      'read_file', 'write_file',
      'kubectl_get', 'kubectl_describe', 'kubectl_logs', 'kubectl_exec',
      'kubectl_apply', 'kubectl_delete',
      'gh_pr_list', 'gh_pr_create', 'gh_run_list', 'gh_run_view',
      'git_commit', 'git_push',
    ] as [CodeOpAction, ...CodeOpAction[]]).describe('Operation to perform'),
    confirmed: z.boolean().optional().describe('Required true for DESTRUCTIVE actions'),
    // file ops
    path: z.string().optional().describe('Absolute file path (read_file/write_file). Must be under /home/pedro/PeteDio-Labs'),
    content: z.string().optional().describe('File content to write (write_file)'),
    // kubectl
    namespace: z.string().optional().describe('Kubernetes namespace'),
    resource: z.string().optional().describe('Kubernetes resource type (pod, deployment, service, …)'),
    name: z.string().optional().describe('Resource name'),
    container: z.string().optional().describe('Container name (kubectl_logs multi-container)'),
    lines: z.number().optional().describe('Log lines to tail (kubectl_logs, default 100)'),
    exec_command: z.array(z.string()).optional().describe('Command to run inside pod (kubectl_exec)'),
    manifest_path: z.string().optional().describe('Manifest file path (kubectl_apply/delete)'),
    // gh
    repo: z.string().optional().describe('GitHub repo in owner/repo format'),
    title: z.string().optional().describe('PR title (gh_pr_create)'),
    body: z.string().optional().describe('PR body markdown (gh_pr_create)'),
    base: z.string().optional().describe('Base branch (gh_pr_create, default: main)'),
    head: z.string().optional().describe('Head branch (gh_pr_create)'),
    run_id: z.string().optional().describe('GitHub Actions run ID (gh_run_view)'),
    // git
    message: z.string().optional().describe('Commit message (git_commit)'),
    paths: z.array(z.string()).optional().describe('Files to stage (git_commit, default: all changes)'),
    remote: z.string().optional().describe('Git remote (git_push, default: origin)'),
    branch: z.string().optional().describe('Branch to push (git_push, default: current branch)'),
    cwd: z.string().optional().describe('Working directory for git commands (default: /home/pedro/PeteDio-Labs)'),
  },
  async (args) => {
    const result = await codeOp(args as Parameters<typeof codeOp>[0]);
    return { content: [{ type: 'text', text: result }] };
  },
);

server.tool(
  'code_plan',
  'Execute a step-by-step coding plan. ' +
  'PREFERRED: provide your own plan as JSON via the `plan` parameter — Claude plans here (fast, free), ' +
  'tool executes. No Ollama needed. ' +
  'FALLBACK: omit `plan` and provide only `task` to have Ollama generate the plan (slow, ~30-60s). ' +
  'Plan format: JSON array of {step, description, tool:"code_op", args, risk_tier} objects.',
  {
    task: z.string().min(1).describe('Task description'),
    plan: z.string().optional().describe(
      'Pre-written plan as JSON array of PlanStep objects. When provided, Ollama is skipped. ' +
      'Example: [{"step":1,"description":"Read file","tool":"code_op","args":{"action":"read_file","path":"/home/pedro/PeteDio-Labs/..."},"risk_tier":"READ_ONLY"}]'
    ),
  },
  async ({ task, plan }) => {
    const result = await codePlan(task, OLLAMA_HOST, CODER_MODEL, plan);
    return { content: [{ type: 'text', text: result }] };
  },
);

// ─── Start ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
