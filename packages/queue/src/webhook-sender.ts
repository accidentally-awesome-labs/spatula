import { createHmac, randomUUID } from 'node:crypto';
import { createLogger } from '@spatula/shared';
import type { WebhookEvent, WebhookEventType, WebhookConfig } from '@spatula/shared';
import type { Queue } from 'bullmq';
import type { WebhookJobData } from './queues.js';

const logger = createLogger('webhook-sender');
const TIMEOUT_MS = 10_000;

export class WebhookSender {
  async send(url: string, event: WebhookEvent, secret?: string): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Spatula-Webhook/1.0',
    };

    if (secret) {
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      headers['X-Spatula-Signature'] = `sha256=${signature}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status}`);
    }

    logger.debug({ url, eventType: event.type, eventId: event.id }, 'webhook delivered');
  }
}

/**
 * Fire-and-forget webhook enqueue. Checks if the job has webhook config
 * and if the event type is subscribed before enqueuing.
 */
export function enqueueWebhookIfConfigured(
  webhookQueue: Queue<WebhookJobData>,
  webhookConfig: WebhookConfig | undefined,
  eventType: WebhookEventType,
  data: WebhookEvent['data'],
): void {
  if (!webhookConfig) return;
  if (!webhookConfig.events.includes(eventType)) return;

  const event: WebhookEvent = {
    id: `evt_${randomUUID().slice(0, 12)}`,
    type: eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  webhookQueue
    .add('webhook', {
      url: webhookConfig.url,
      event,
      secret: webhookConfig.secret,
    })
    .catch((err) => {
      logger.warn({ err, eventType }, 'failed to enqueue webhook event');
    });
}
