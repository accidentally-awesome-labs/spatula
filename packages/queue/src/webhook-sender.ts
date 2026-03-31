import { createHmac } from 'node:crypto';
import { createLogger } from '@spatula/shared';
import type { WebhookEvent } from '@spatula/shared';

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
