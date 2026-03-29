/**
 * mcp-homelab — Unified MCP server for PeteDio Labs.
 * Merges docs-context + pm-agent + infra/event tools into a single server with 13 tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Docs-context tools
import { listDocs } from './tools/listDocs.js';
import { gatherContext, formatContextForWriter } from './tools/gatherContext.js';
import { triggerPipeline } from './tools/triggerPipeline.js';

// PM-agent tools
import { getStatus, formatStatus } from './tools/getStatus.js';
import { createTasks, formatCreateResult, type TaskInput } from './tools/createTasks.js';
import { planProject, formatPlanResult } from './tools/planProject.js';
import { summarize } from './tools/summarize.js';
import { getBlogContext, formatBlogContext } from './tools/getBlogContext.js';

// Blog direct-write tools
import { saveDraft, publishPost } from './tools/saveDraft.js';
import { healthCheck } from './clients/blogApi.js';

// Infra + event tools (Phase 1)
import { getInfraStatus, formatInfraStatus } from './tools/infraStatus.js';
import { getEvents, formatEvents } from './tools/events.js';
import { notify } from './tools/notify.js';

// Environment
const DOCS_ROOT = process.env.DOCS_ROOT || '/home/pedro/PeteDio-Labs/docs';
const BLOG_AGENT_URL = process.env.BLOG_AGENT_URL || 'http://localhost:3004';

const VALID_PROJECTS = ['pm-agent', 'pete-vision', 'blog', 'mission-control', 'infrastructure', 'notification-service', 'web-search', 'mcp-homelab'] as const;
const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;
const VALID_STATUSES = ['Todo', 'In Progress', 'Done', 'Blogged'] as const;

const server = new McpServer({
  name: 'homelab',
  version: '0.1.0',
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

server.tool(
  'trigger_pipeline',
  `Trigger the blog-agent content pipeline with project context injected. Gathers doc context automatically, optionally includes GitHub Projects completed items.`,
  {
    contentType: z.enum(['weekly-recap', 'how-to', 'docs-audit'])
      .describe('Type of blog post to generate'),
    topic: z.string().optional()
      .describe('Optional topic for how-to or focused posts'),
    includeGitHub: z.boolean().default(false)
      .describe('Also pull completed GitHub Project items into context'),
    blogAgentUrl: z.string().optional()
      .describe(`Override blog-agent URL (default: ${BLOG_AGENT_URL})`),
  },
  async ({ contentType, topic, includeGitHub, blogAgentUrl }) => {
    const url = blogAgentUrl || BLOG_AGENT_URL;

    // Pre-flight: check blog-agent is reachable
    try {
      const healthRes = await fetch(`${url}/health`);
      if (!healthRes.ok) {
        return { content: [{ type: 'text', text: `Blog-agent health check failed (${healthRes.status}). Is it running?` }] };
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Cannot reach blog-agent at ${url}: ${err instanceof Error ? err.message : err}` }] };
    }

    const result = await triggerPipeline(DOCS_ROOT, url, contentType, topic);
    return {
      content: [{
        type: 'text',
        text: result.success
          ? `Pipeline triggered successfully.\nRun ID: ${result.runId}\nStatus: ${result.status}`
          : `Pipeline trigger failed: ${result.error}`,
      }],
    };
  },
);

// ─── Blog Direct Write Tools ───────────────────────────────────

server.tool(
  'save_draft',
  'Save a blog post directly to the blog-api database (bypasses blog-agent LLM pipeline). Use for Claude-written content or when the pipeline fails at save.',
  {
    title: z.string().describe('Post title'),
    content: z.string().describe('Post content in markdown'),
    excerpt: z.string().describe('Short excerpt/summary (under 200 chars)'),
    tags: z.array(z.string()).default([]).describe('Tag names for the post'),
    status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT')
      .describe('Post status — DRAFT for review, PUBLISHED to go live'),
  },
  async ({ title, content, excerpt, tags, status }) => {
    // Pre-flight
    const apiUp = await healthCheck();
    if (!apiUp) {
      return { content: [{ type: 'text', text: 'Blog API is unreachable. Is the port-forward running? (kubectl port-forward -n blog-dev svc/blog-api 8080:8080)' }] };
    }

    const result = await saveDraft(title, content, excerpt, tags, status);
    if (result.success && result.post) {
      return {
        content: [{
          type: 'text',
          text: `Post saved successfully!\nID: ${result.post.id}\nSlug: ${result.post.slug}\nStatus: ${result.post.status}\nTags: ${result.post.tags.map(t => t.name).join(', ')}`,
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

// ─── PM-Agent Tools ────────────────────────────────────────────

server.tool(
  'get_status',
  `Get current project status from the GitHub Projects board. Returns tasks grouped by status, in-progress items, and blockers.\n\nBoard fields: Project (${VALID_PROJECTS.join(', ')}), Priority (${VALID_PRIORITIES.join(', ')}), Status (${VALID_STATUSES.join(', ')})`,
  {
    projectNumber: z.coerce.number().describe('GitHub Project number (use 1 for PeteDio Labs Backlog)'),
    projectFilter: z.string().optional().describe(`Filter by project name: ${VALID_PROJECTS.join(', ')}`),
  },
  async ({ projectNumber, projectFilter }) => {
    const summary = await getStatus(projectNumber, projectFilter);
    const text = formatStatus(summary);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'create_tasks',
  `Create tasks on the GitHub Project board. Creates draft items by default (no repo needed). If repo is provided, creates repo issues instead.\n\nBoard fields: Project (${VALID_PROJECTS.join(', ')}), Priority (${VALID_PRIORITIES.join(', ')}), Status (${VALID_STATUSES.join(', ')})`,
  {
    tasks: z.array(z.object({
      title: z.string().describe('Issue title (imperative, under 80 chars)'),
      description: z.string().describe('Issue body/description in markdown'),
      priority: z.enum(VALID_PRIORITIES).describe('Task priority'),
      project: z.enum(VALID_PROJECTS).optional().describe('Project tag (overrides top-level projectName)'),
      dependsOn: z.array(z.string()).optional().describe('List of dependency descriptions'),
    })).describe('Array of tasks to create'),
    projectNumber: z.coerce.number().describe('GitHub Project number (use 1 for PeteDio Labs Backlog)'),
    projectName: z.enum(VALID_PROJECTS).optional().describe('Default project tag for all tasks'),
    repo: z.string().optional().describe('Optional: target repo for issues (e.g., "PeteDio-Labs/blog-api"). Omit for draft items.'),
  },
  async ({ tasks, projectNumber, projectName, repo }) => {
    const result = await createTasks(tasks as TaskInput[], projectNumber, projectName, repo);
    const text = formatCreateResult(result);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'plan_project',
  `Read an architecture plan doc and use Ollama (petedio-planner) to break it into phased, actionable GitHub issues. Returns structured task breakdown for create_tasks.\n\nProject: ${VALID_PROJECTS.join(', ')}`,
  {
    planFile: z.string().describe('Path to plan doc (relative to docs root or absolute)'),
    projectName: z.enum(VALID_PROJECTS).describe('Project label for the tasks'),
  },
  async ({ planFile, projectName }) => {
    const result = await planProject(planFile, projectName);
    const text = formatPlanResult(result);
    return {
      content: [
        { type: 'text', text },
        { type: 'text', text: `\n\n---\n**Raw JSON (for create_tasks):**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` },
      ],
    };
  },
);

server.tool(
  'summarize',
  'Generate a human-readable project summary using Ollama. Reads the current board state and produces a status report with health assessment, blockers, and next actions.',
  {
    projectNumber: z.coerce.number().describe('GitHub Project number (use 1 for PeteDio Labs Backlog)'),
  },
  async ({ projectNumber }) => {
    const text = await summarize(projectNumber);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'get_blog_context',
  `Get blog-ready context for a project by pulling all completed (Done) items that haven't been blogged yet. Returns structured summary + JSON context for blog-agent. Marks items as "Blogged" by default.\n\nProject: ${VALID_PROJECTS.join(', ')}`,
  {
    projectNumber: z.coerce.number().describe('GitHub Project number (use 1 for PeteDio Labs Backlog)'),
    projectFilter: z.enum(VALID_PROJECTS).describe('Project to gather blog context for'),
    dryRun: z.coerce.boolean().optional().describe('If true, preview context without marking items as Blogged'),
  },
  async ({ projectNumber, projectFilter, dryRun }) => {
    const ctx = await getBlogContext(projectNumber, projectFilter, !dryRun);
    const text = formatBlogContext(ctx);
    return { content: [{ type: 'text', text }] };
  },
);

// ─── Infra + Event Tools ────────────────────────────────────────

server.tool(
  'get_infra_status',
  'Get a combined infrastructure status view: ArgoCD app sync/health, Prometheus cluster health, and Proxmox node stats. Requires port-forward to MC backend (3000).',
  {},
  async () => {
    const status = await getInfraStatus();
    const text = formatInfraStatus(status);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'get_events',
  'Get recent infrastructure events from the notification service. Filter by source (kubernetes/proxmox/argocd) and severity (info/warning/critical). Requires port-forward to notification-service (3002).',
  {
    limit: z.number().min(1).max(100).default(20).describe('Max events to return'),
    source: z.enum(['kubernetes', 'proxmox', 'argocd']).optional().describe('Filter by event source'),
    severity: z.enum(['info', 'warning', 'critical']).optional().describe('Filter by severity'),
  },
  async ({ limit, source, severity }) => {
    const result = await getEvents(limit, source, severity);
    const text = formatEvents(result);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'send_notification',
  'Publish an infrastructure event to the notification service. Events are queued and fanned out to Discord + webhook subscribers. Requires port-forward to notification-service (3002).',
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
      return { content: [{ type: 'text', text: `Event published successfully (ID: ${result.id})` }] };
    }
    return { content: [{ type: 'text', text: `Failed to send notification: ${result.error}` }] };
  },
);

// ─── Start ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
