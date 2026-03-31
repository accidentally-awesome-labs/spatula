import { Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { createLogger } from '@spatula/shared';
import { WebhookSender } from './webhook-sender.js';
import { QUEUE_NAMES } from './queues.js';
import type { WebhookJobData } from './queues.js';

const logger = createLogger('webhook-worker');

// Custom backoff: 1min, 5min, 30min
const BACKOFF_DELAYS = [60_000, 300_000, 1_800_000];

export function createWebhookWorker(connection: ConnectionOptions): Worker<WebhookJobData> {
  const sender = new WebhookSender();

  const worker = new Worker<WebhookJobData>(
    QUEUE_NAMES.WEBHOOK,
    async (job: Job<WebhookJobData>) => {
      const { url, event, secret } = job.data;
      logger.info(
        { eventId: event.id, eventType: event.type, url, attempt: job.attemptsMade + 1 },
        'delivering webhook',
      );
      await sender.send(url, event, secret);
    },
    {
      connection,
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          return BACKOFF_DELAYS[Math.min(attemptsMade, BACKOFF_DELAYS.length - 1)];
        },
      },
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      { jobId: job?.id, eventId: job?.data.event.id, error: err.message, attempt: job?.attemptsMade },
      'webhook delivery failed',
    );
  });

  return worker;
}
