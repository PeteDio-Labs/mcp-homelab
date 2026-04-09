/**
 * mcp-homelab — Claude Code interface for PeteDio Labs.
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
import { healthCheck } from './clients/blogApi.js';
import { notify } from './tools/notify.js';
import { listAgentsTool, getTaskStatusTool, runAgentTool } from './tools/agentControl.js';

const DOCS_ROOT = process.env.DOCS_ROOT || '/home/pedro/PeteDio-Labs/knowledge';

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
  'Show the latest run status for each registered agent (blog-agent, ops-investigator, knowledge-janitor, pm-agent). Includes health, last task ID, status, and summary.',
  {},
  async () => {
    const text = await listAgentsTool();
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
  'Trigger a whitelisted agent (knowledge-janitor or ops-investigator only). Returns a task ID to poll with get_task_status. Write agents (blog-agent, pm-agent) are not allowed.',
  {
    agentName: z.enum(['knowledge-janitor', 'ops-investigator']).describe('Agent to trigger'),
    input: z.record(z.string(), z.unknown()).default({}).describe('Input payload for the agent'),
  },
  async ({ agentName, input }) => {
    const text = await runAgentTool(agentName, input);
    return { content: [{ type: 'text', text }] };
  },
);

// ─── Start ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
