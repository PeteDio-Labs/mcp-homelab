/**
 * Agent control tools for MCP.
 *
 * Phase 2: list_agents, get_task_status, list_agent_queue (read-only)
 * Phase 4: run_agent (controlled trigger surface)
 */

import { listAgents, getTaskStatus, listAgentQueue, triggerAgent, type AgentRun } from '../clients/missionControl.js';

// ─── Helpers ─────────────────────────────────────────────────────

function formatRun(run: AgentRun): string {
  const lines: string[] = [
    `agent: ${run.agent_name}`,
    `taskId: ${run.task_id}`,
    `status: ${run.status}`,
    `trigger: ${run.trigger}`,
    `issued: ${run.issued_at}`,
  ];
  if (run.completed_at) lines.push(`completed: ${run.completed_at}`);
  if (run.duration_ms != null) lines.push(`duration: ${run.duration_ms}ms`);
  if (run.summary) lines.push(`summary: ${run.summary}`);
  if (run.current_message) lines.push(`message: ${run.current_message}`);
  if (run.health) lines.push(`health: ${run.health.status} (checked ${run.health.checkedAt})`);
  return lines.join('\n');
}

// ─── Trigger surface ──────────────────────────────────────────────

const TRIGGERABLE_AGENTS = [
  'knowledge-janitor',
  'ops-investigator',
  'workstation-agent',
  'infra-agent',
  'pm-agent',
  'blog-agent',
] as const;

const TRIGGER_ALLOWLIST = new Set<string>(TRIGGERABLE_AGENTS);

// ─── Tool implementations ─────────────────────────────────────────

export async function listAgentsTool(): Promise<string> {
  const agents = await listAgents();
  if (agents.length === 0) return 'No agent runs found.';
  return agents.map(formatRun).join('\n\n---\n\n');
}

export async function listAgentQueueTool(): Promise<string> {
  const queue = await listAgentQueue();
  if (queue.length === 0) return 'No queued or running agent tasks.';
  return queue.map(formatRun).join('\n\n---\n\n');
}

export async function getTaskStatusTool(taskId: string): Promise<string> {
  const run = await getTaskStatus(taskId);
  if (!run) return `No run found for taskId: ${taskId}`;
  return formatRun(run);
}

export async function runAgentTool(agentName: string, input: Record<string, unknown> = {}): Promise<string> {
  if (!TRIGGER_ALLOWLIST.has(agentName)) {
    const allowed = Array.from(TRIGGER_ALLOWLIST).join(', ');
    return `Agent "${agentName}" is not in the trigger whitelist. Allowed agents: ${allowed}`;
  }
  const taskId = await triggerAgent(agentName, input);
  return `Agent "${agentName}" triggered successfully.\ntaskId: ${taskId}\n\nUse get_task_status("${taskId}") to check progress.`;
}

export async function watchAgentTool(taskId: string): Promise<string> {
  const run = await getTaskStatus(taskId);
  if (!run) return `No run found for taskId: ${taskId}`;
  const lines = [formatRun(run)];
  if (run.status === 'queued' || run.status === 'running') {
    lines.push('', 'This task is still active. Use watch_agent again to poll.');
  }
  return lines.join('\n');
}

export async function runInfraCheckTool(
  mode: 'health-check' | 'check-capacity' | 'list-vms' | 'list-playbooks' | 'get-inventory',
): Promise<string> {
  return runAgentTool('infra-agent', { mode, gated: false });
}

export async function runInfraPlaybookTool(
  mode: 'deploy-local-agents' | 'sync-ollama-models' | 'update-ollama-service' | 'verify-cloudflare-tunnel' | 'dry-run-playbook' | 'run-playbook',
  opts: { playbook?: string; extraVars?: string; tags?: string; gated?: boolean } = {},
): Promise<string> {
  const input: Record<string, unknown> = {
    mode,
    gated: opts.gated ?? false,
  };
  if (opts.playbook) input.playbook = opts.playbook;
  if (opts.extraVars) input.extraVars = opts.extraVars;
  if (opts.tags) input.tags = opts.tags;
  return runAgentTool('infra-agent', input);
}

export async function runCloudflareTunnelTool(
  action: 'routes' | 'dns' | 'dns-cleanup' | 'verify' | 'connector',
  opts: { gated?: boolean } = {},
): Promise<string> {
  const input: Record<string, unknown> = {
    mode: `cloudflare-tunnel-${action}`,
    gated: opts.gated ?? false,
  };
  return runAgentTool('infra-agent', input);
}

export async function runWorkstationGrepReplaceTool(
  opts: { pattern: string; replacement?: string; pathGlob?: string; dryRun?: boolean; gated?: boolean },
): Promise<string> {
  const input: Record<string, unknown> = {
    mode: 'grep-replace',
    pattern: opts.pattern,
    dryRun: opts.dryRun ?? true,
    gated: opts.gated ?? false,
  };
  if (opts.replacement !== undefined) input.replacement = opts.replacement;
  if (opts.pathGlob) input.pathGlob = opts.pathGlob;
  return runAgentTool('workstation-agent', input);
}

export async function runWorkstationTaskTool(
  mode: 'inspect-repo' | 'git-status' | 'git-log' | 'bun' | 'kubectl-get' | 'read-file' | 'write-file' | 'systemd-restart' | 'command',
  opts: {
    workDir?: string;
    gated?: boolean;
    command?: string;
    path?: string;
    content?: string;
    script?: string;
    resource?: string;
    unit?: string;
    gitLogCount?: number;
  } = {},
): Promise<string> {
  const input: Record<string, unknown> = {
    mode,
    workDir: opts.workDir ?? '/home/pedro/PeteDio-Labs',
    gated: opts.gated ?? false,
  };
  if (opts.command) input.command = opts.command;
  if (opts.path) input.path = opts.path;
  if (opts.content !== undefined) input.content = opts.content;
  if (opts.script) input.script = opts.script;
  if (opts.resource) input.resource = opts.resource;
  if (opts.unit) input.unit = opts.unit;
  if (opts.gitLogCount !== undefined) input.gitLogCount = opts.gitLogCount;
  return runAgentTool('workstation-agent', input);
}
