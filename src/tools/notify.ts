/**
 * send_notification tool — publish an event to notification-service.
 */

import {
  sendEvent,
  healthCheck,
  type InfraEventInput,
} from '../clients/notificationService.js';

export interface NotifyResult {
  success: boolean;
  id?: string;
  error?: string;
}

export async function notify(event: InfraEventInput): Promise<NotifyResult> {
  const reachable = await healthCheck();
  if (!reachable) {
    return {
      success: false,
      error: 'Notification service unreachable — is the port-forward running? (kubectl port-forward -n mission-control svc/notification-service 3002:3002)',
    };
  }

  try {
    const result = await sendEvent(event);
    return { success: true, id: result.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
