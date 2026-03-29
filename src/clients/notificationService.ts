/**
 * Notification Service client.
 * Fetch-based, function exports — mirrors blogApi.ts pattern.
 */

import type { InfraEventInput, InfraEvent, EventSource, Severity } from '@petedio/shared';
export type { InfraEventInput, InfraEvent, EventSource, Severity };

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';
const TIMEOUT_MS = 10_000;

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// ─── API ────────────────────────────────────────────────────────

export async function sendEvent(event: InfraEventInput): Promise<{ id: string; status: string }> {
  const res = await fetch(`${NOTIFICATION_SERVICE_URL}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: signal(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notification Service POST /events failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<{ id: string; status: string }>;
}

export async function getRecentEvents(limit = 20): Promise<InfraEvent[]> {
  const res = await fetch(`${NOTIFICATION_SERVICE_URL}/api/v1/events?limit=${limit}`, {
    signal: signal(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notification Service GET /events failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  // API may return { events: [...] } or raw array
  return Array.isArray(data) ? data : (data as { events: InfraEvent[] }).events ?? [];
}

// ─── Health ─────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${NOTIFICATION_SERVICE_URL}/health`, { signal: signal() });
    return res.ok;
  } catch {
    return false;
  }
}
