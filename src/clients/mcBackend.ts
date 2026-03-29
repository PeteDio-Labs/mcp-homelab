/**
 * Mission Control Backend client.
 * Fetch-based, function exports — mirrors blogApi.ts pattern.
 */

const MC_BACKEND_URL = process.env.MC_BACKEND_URL || 'http://localhost:3000';
const TIMEOUT_MS = 10_000;

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${MC_BACKEND_URL}${path}`, { signal: signal() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MC Backend GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── ArgoCD ─────────────────────────────────────────────────────

export interface ArgoApp {
  name: string;
  namespace: string;
  project: string;
  status: { sync: { status: string }; health: { status: string } };
  [key: string]: unknown;
}

export async function getArgoApps(): Promise<ArgoApp[]> {
  const data = await get<{ applications: ArgoApp[] }>('/api/v1/argocd/applications');
  return data.applications ?? [];
}

export async function getArgoAppStatus(name: string): Promise<ArgoApp> {
  return get<ArgoApp>(`/api/v1/argocd/applications/${encodeURIComponent(name)}`);
}

// ─── Prometheus ─────────────────────────────────────────────────

export interface ClusterHealth {
  [key: string]: unknown;
}

export async function getClusterHealth(): Promise<ClusterHealth> {
  return get<ClusterHealth>('/api/v1/prometheus/cluster/health');
}

// ─── Proxmox ────────────────────────────────────────────────────

export interface ProxmoxNode {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  [key: string]: unknown;
}

export async function getProxmoxNodes(): Promise<ProxmoxNode[]> {
  const data = await get<{ nodes: ProxmoxNode[] }>('/api/v1/proxmox/nodes');
  return data.nodes ?? [];
}

// ─── Inventory ──────────────────────────────────────────────────

export interface Inventory {
  hosts: unknown[];
  workloads: unknown[];
  [key: string]: unknown;
}

export async function getInventory(): Promise<Inventory> {
  return get<Inventory>('/api/v1/inventory');
}

// ─── Health ─────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${MC_BACKEND_URL}/health`, { signal: signal() });
    return res.ok;
  } catch {
    return false;
  }
}
