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

export interface GatedAction {
  actionType: string;
  description: string;
  preview?: string;
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
  pending_approval: GatedAction | null;
  issued_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  health: AgentHealth | null;
}

export type ProxmoxResourceType = 'node' | 'vm' | 'lxc' | 'storage';
export type ProxmoxKind = 'vm' | 'lxc';
export type ProxmoxPowerAction = 'start' | 'stop' | 'restart';

async function parseJsonOrThrow<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${context} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── API ─────────────────────────────────────────────────────────

/** Returns the latest run for each registered agent. */
export async function listAgents(): Promise<AgentRun[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents`, { signal: signal() });
  const data = await parseJsonOrThrow<{ agents: AgentRun[] }>(res, 'MC Backend GET /agents');
  return data.agents;
}

/** Returns a single agent run by task ID. */
export async function getTaskStatus(taskId: string): Promise<AgentRun | null> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${encodeURIComponent(taskId)}`, {
    signal: signal(),
  });
  if (res.status === 404) return null;
  const data = await parseJsonOrThrow<{ run: AgentRun }>(res, `MC Backend GET /agents/${taskId}`);
  return data.run;
}

/** Returns queued and running agent tasks. */
export async function listAgentQueue(): Promise<AgentRun[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/queue`, { signal: signal() });
  const data = await parseJsonOrThrow<{ queue: AgentRun[] }>(res, 'MC Backend GET /agents/queue');
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
  const data = await parseJsonOrThrow<{ taskId: string }>(res, `MC Backend POST /agents/${agentName}/trigger`);
  return data.taskId;
}

/** Returns Proxmox connector status from Mission Control backend. */
export async function getProxmoxStatus(): Promise<{ connected: boolean; timestamp: string }> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/status`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: { connected: boolean; timestamp: string } }>(res, 'MC Backend GET /proxmox/status');
  return data.data;
}

/** Returns Proxmox nodes from Mission Control backend. */
export async function getProxmoxNodes(): Promise<unknown[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/nodes`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: unknown[] }>(res, 'MC Backend GET /proxmox/nodes');
  return data.data;
}

/** Returns Proxmox node status from Mission Control backend. */
export async function getProxmoxNodeStatus(node: string): Promise<unknown> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/nodes/${encodeURIComponent(node)}/status`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: unknown }>(res, `MC Backend GET /proxmox/nodes/${node}/status`);
  return data.data;
}

/** Returns Proxmox cluster resources from Mission Control backend. */
export async function getProxmoxResources(type?: ProxmoxResourceType): Promise<unknown[]> {
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/resources${query}`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: unknown[] }>(res, 'MC Backend GET /proxmox/resources');
  return data.data;
}

/** Returns VMs for a Proxmox node from Mission Control backend. */
export async function getProxmoxNodeVMs(node: string): Promise<unknown[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/nodes/${encodeURIComponent(node)}/vms`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: unknown[] }>(res, `MC Backend GET /proxmox/nodes/${node}/vms`);
  return data.data;
}

/** Returns LXCs for a Proxmox node from Mission Control backend. */
export async function getProxmoxNodeLXCs(node: string): Promise<unknown[]> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/proxmox/nodes/${encodeURIComponent(node)}/lxc`, { signal: signal() });
  const data = await parseJsonOrThrow<{ data: unknown[] }>(res, `MC Backend GET /proxmox/nodes/${node}/lxc`);
  return data.data;
}

/** Executes VM/LXC power action through Mission Control backend. */
export async function runProxmoxPowerAction(
  kind: ProxmoxKind,
  node: string,
  vmid: number,
  action: ProxmoxPowerAction,
): Promise<{ success: boolean; message: string }> {
  const path = kind === 'vm' ? 'vms' : 'lxc';
  const res = await fetch(
    `${MC_BACKEND_URL}/api/v1/proxmox/nodes/${encodeURIComponent(node)}/${path}/${vmid}/${action}`,
    { method: 'POST', signal: signal() },
  );
  const data = await parseJsonOrThrow<{ data: { success: boolean; message: string } }>(res, `MC Backend POST /proxmox/nodes/${node}/${path}/${vmid}/${action}`);
  return data.data;
}

/** Approve a gated action for a task in waiting_approval state. */
export async function approveTask(taskId: string): Promise<{ taskId: string; status: string; outcome: string }> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${encodeURIComponent(taskId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: signal(),
  });
  return parseJsonOrThrow<{ taskId: string; status: string; outcome: string }>(res, `MC Backend POST /agents/${taskId}/approve`);
}

/** Reject a gated action for a task in waiting_approval state. */
export async function rejectTask(taskId: string, reason?: string): Promise<{ taskId: string; status: string; outcome: string }> {
  const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${encodeURIComponent(taskId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
    signal: signal(),
  });
  return parseJsonOrThrow<{ taskId: string; status: string; outcome: string }>(res, `MC Backend POST /agents/${taskId}/reject`);
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
