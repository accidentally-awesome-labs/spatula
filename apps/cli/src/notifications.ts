import { createLogger } from '@spatula/shared';

const logger = createLogger('cli:notifications');

export async function sendDesktopNotification(title: string, message: string): Promise<void> {
  if (process.env.CI || process.env.DOCKER) return;
  try {
    const notifier = await import('node-notifier');
    notifier.default.notify({ title, message, sound: true });
  } catch (err) {
    logger.debug({ err }, 'Desktop notification not available');
  }
}

export async function sendWebhookNotification(
  webhookUrl: string,
  event: { type: string; data: Record<string, unknown> },
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, webhookUrl }, 'Webhook notification failed');
    }
  } catch (err) {
    logger.warn({ err, webhookUrl }, 'Webhook notification error');
  }
}
