/**
 * Agent control tools for MCP.
 *
 * Phase 2: list_agents, get_task_status (read-only)
 * Phase 4: run_agent (whitelist-only trigger)
 */

import { listAgents, getTaskStatus, triggerAgent, type AgentRun } from '../clients/missionControl.js';

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

// ─── Whitelist (Phase 4) ──────────────────────────────────────────

const TRIGGER_WHITELIST = new Set(['knowledge-janitor', 'ops-investigator']);

// ─── Tool implementations ─────────────────────────────────────────

export async function listAgentsTool(): Promise<string> {
  const agents = await listAgents();
  if (agents.length === 0) return 'No agent runs found.';
  return agents.map(formatRun).join('\n\n---\n\n');
}

export async function getTaskStatusTool(taskId: string): Promise<string> {
  const run = await getTaskStatus(taskId);
  if (!run) return `No run found for taskId: ${taskId}`;
  return formatRun(run);
}

export async function runAgentTool(agentName: string, input: Record<string, unknown> = {}): Promise<string> {
  if (!TRIGGER_WHITELIST.has(agentName)) {
    const allowed = Array.from(TRIGGER_WHITELIST).join(', ');
    return `Agent "${agentName}" is not in the trigger whitelist. Allowed agents: ${allowed}`;
  }
  const taskId = await triggerAgent(agentName, input);
  return `Agent "${agentName}" triggered successfully.\ntaskId: ${taskId}\n\nUse get_task_status("${taskId}") to check progress.`;
}
