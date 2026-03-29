/**
 * get_infra_status tool — combines ArgoCD + Prometheus + Proxmox into one view.
 */

import { getArgoApps, getClusterHealth, getProxmoxNodes, healthCheck } from '../clients/mcBackend.js';

export interface InfraStatusResult {
  healthy: boolean;
  mcBackendReachable: boolean;
  argoApps?: { total: number; synced: number; healthy: number; apps: { name: string; sync: string; health: string }[] };
  clusterHealth?: Record<string, unknown>;
  proxmoxNodes?: { name: string; status: string; cpuPct: string; memPct: string }[];
  errors: string[];
}

export async function getInfraStatus(): Promise<InfraStatusResult> {
  const result: InfraStatusResult = { healthy: true, mcBackendReachable: false, errors: [] };

  // Pre-flight
  result.mcBackendReachable = await healthCheck();
  if (!result.mcBackendReachable) {
    result.healthy = false;
    result.errors.push('MC Backend unreachable — is the port-forward running? (kubectl port-forward -n mission-control svc/mission-control-backend 3000:3000)');
    return result;
  }

  // Fetch all in parallel
  const [argoResult, healthResult, proxmoxResult] = await Promise.allSettled([
    getArgoApps(),
    getClusterHealth(),
    getProxmoxNodes(),
  ]);

  // ArgoCD
  if (argoResult.status === 'fulfilled') {
    const apps = argoResult.value;
    const synced = apps.filter(a => a.status?.sync?.status === 'Synced').length;
    const healthy = apps.filter(a => a.status?.health?.status === 'Healthy').length;
    result.argoApps = {
      total: apps.length,
      synced,
      healthy,
      apps: apps.map(a => ({
        name: a.name,
        sync: a.status?.sync?.status ?? 'Unknown',
        health: a.status?.health?.status ?? 'Unknown',
      })),
    };
    if (synced < apps.length || healthy < apps.length) result.healthy = false;
  } else {
    result.errors.push(`ArgoCD: ${argoResult.reason}`);
    result.healthy = false;
  }

  // Prometheus cluster health
  if (healthResult.status === 'fulfilled') {
    result.clusterHealth = healthResult.value;
  } else {
    result.errors.push(`Prometheus: ${healthResult.reason}`);
  }

  // Proxmox
  if (proxmoxResult.status === 'fulfilled') {
    result.proxmoxNodes = proxmoxResult.value.map(n => ({
      name: n.node,
      status: n.status,
      cpuPct: `${(n.cpu * 100).toFixed(1)}%`,
      memPct: `${((n.mem / n.maxmem) * 100).toFixed(1)}%`,
    }));
  } else {
    result.errors.push(`Proxmox: ${proxmoxResult.reason}`);
  }

  return result;
}

export function formatInfraStatus(r: InfraStatusResult): string {
  const lines: string[] = [];
  lines.push(`## Infrastructure Status ${r.healthy ? '(Healthy)' : '(Degraded)'}`);
  lines.push('');

  if (!r.mcBackendReachable) {
    lines.push('MC Backend: UNREACHABLE');
    lines.push(...r.errors);
    return lines.join('\n');
  }

  if (r.argoApps) {
    lines.push(`### ArgoCD — ${r.argoApps.synced}/${r.argoApps.total} synced, ${r.argoApps.healthy}/${r.argoApps.total} healthy`);
    for (const app of r.argoApps.apps) {
      const icon = app.sync === 'Synced' && app.health === 'Healthy' ? '+' : '!';
      lines.push(`  [${icon}] ${app.name} — sync: ${app.sync}, health: ${app.health}`);
    }
    lines.push('');
  }

  if (r.clusterHealth) {
    lines.push('### Cluster Health');
    lines.push(JSON.stringify(r.clusterHealth, null, 2));
    lines.push('');
  }

  if (r.proxmoxNodes) {
    lines.push('### Proxmox Nodes');
    for (const n of r.proxmoxNodes) {
      lines.push(`  ${n.name}: ${n.status} — CPU ${n.cpuPct}, MEM ${n.memPct}`);
    }
    lines.push('');
  }

  if (r.errors.length > 0) {
    lines.push('### Errors');
    for (const e of r.errors) lines.push(`  - ${e}`);
  }

  return lines.join('\n');
}
