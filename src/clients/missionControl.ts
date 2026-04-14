/**
 * Mission Control Backend client.
 * Read-only wrappers for the agent registry and run history.
 */

const MC_BACKEND_URL = process.env.MC_BACKEND_URL || 'http://localhost:3000';
const TIMEOUT_MS = 10_000;

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// ─── Types (minimal — shaped from /api/v1/agents responses) ────────

export interface AgentHealth {
  status: 'healthy' | 'unreachable' | 'degraded';
  checkedAt: string;
}

export interface AgentRun {
  id: string;
  task_id: string;
  agent_name: string;
  trigger: string;
  status: string;
  input: Record<string, unknown>;
  result: unknown;
  summary: string | null;
  current_message: string | null;
  issued_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  health: AgentHealth | null;
}

// ─── API ─────────────────────────────────────────────────────────

/** Returns the latest run for each registered agent. */
export async function listAgents(): Promise<AgentRun[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents`, { signal: signal() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MC Backend GET /agents failed (${res.status}): ${body}`);
  }
  const data = await res.json() as { agents: AgentRun[] };
  return data.agents;
}

/** Returns a single agent run by task ID. */
export async function getTaskStatus(taskId: string): Promise<AgentRun | null> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${encodeURIComponent(taskId)}`, {
    signal: signal(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MC Backend GET /agents/${taskId} failed (${res.status}): ${body}`);
  }
  const data = await res.json() as { run: AgentRun };
  return data.run;
}

/** Returns queued and running agent tasks. */
export async function listAgentQueue(): Promise<AgentRun[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/queue`, { signal: signal() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MC Backend GET /agents/queue failed (${res.status}): ${body}`);
  }
  const data = await res.json() as { queue: AgentRun[] };
  return data.queue;
}

/** Trigger a whitelisted agent by name. Returns the new taskId. */
export async function triggerAgent(agentName: string, input: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${encodeURIComponent(agentName)}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger: 'manual', input }),
    signal: signal(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MC Backend POST /agents/${agentName}/trigger failed (${res.status}): ${body}`);
  }
  const data = await res.json() as { taskId: string };
  return data.taskId;
}

// ─── Health ──────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${MC_BACKEND_URL}/health`, { signal: signal() });
    return res.ok;
  } catch {
    return false;
  }
}
