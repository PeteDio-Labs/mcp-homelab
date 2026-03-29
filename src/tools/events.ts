/**
 * get_events tool — read recent events from notification-service.
 */

import {
  getRecentEvents,
  healthCheck,
  type InfraEvent,
  type EventSource,
  type Severity,
} from '../clients/notificationService.js';

export interface EventsResult {
  reachable: boolean;
  events: InfraEvent[];
  total: number;
  error?: string;
}

export async function getEvents(
  limit: number,
  source?: EventSource,
  severity?: Severity,
): Promise<EventsResult> {
  const reachable = await healthCheck();
  if (!reachable) {
    return {
      reachable: false,
      events: [],
      total: 0,
      error: 'Notification service unreachable — is the port-forward running? (kubectl port-forward -n mission-control svc/notification-service 3002:3002)',
    };
  }

  let events = await getRecentEvents(limit);

  if (source) events = events.filter(e => e.source === source);
  if (severity) events = events.filter(e => e.severity === severity);

  return { reachable: true, events, total: events.length };
}

export function formatEvents(r: EventsResult): string {
  if (!r.reachable) return `Notification Service: UNREACHABLE\n${r.error}`;
  if (r.total === 0) return 'No events found matching filters.';

  const lines = [`## Recent Events (${r.total})\n`];
  for (const e of r.events) {
    const ts = typeof e.timestamp === 'string' ? e.timestamp : String(e.timestamp);
    lines.push(`[${e.severity.toUpperCase()}] ${ts} — ${e.source}/${e.type}: ${e.message}`);
    if (e.affected_service) lines.push(`  service: ${e.affected_service}`);
    if (e.namespace) lines.push(`  namespace: ${e.namespace}`);
  }
  return lines.join('\n');
}
