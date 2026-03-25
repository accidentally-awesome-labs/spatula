import { createLogger } from '@spatula/shared';
import type { Job } from 'bullmq';
import type { DlqRepository } from '@spatula/db';

const logger = createLogger('dlq-handler');

/**
 * Creates a BullMQ `failed` event handler that moves permanently failed
 * jobs to the dead letter queue table.
 *
 * Only inserts when the job has exhausted all retry attempts
 * (attemptsMade >= opts.attempts). Transient failures that will be
 * retried are ignored.
 *
 * The handler never throws — DLQ insertion failures are logged but
 * do not affect the worker's operation.
 */
export function createDlqHandler(dlqRepo: DlqRepository) {
  return async (job: Job | undefined, err: Error): Promise<void> => {
    if (!job) {
      logger.warn({ error: err.message }, 'DLQ handler called without job reference');
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Job will be retried — don't move to DLQ yet
      return;
    }

    try {
      await dlqRepo.insert({
        queueName: job.queueName,
        jobId: job.id ?? 'unknown',
        tenantId: (job.data as any)?.tenantId,
        spatulaJobId: (job.data as any)?.jobId,
        payload: job.data,
        errorMessage: err.message,
        errorStack: err.stack,
        attempts: job.attemptsMade,
      });
    } catch (dlqError) {
      // Never throw from the DLQ handler — log and continue
      logger.error(
        { jobId: job.id, queueName: job.queueName, error: (dlqError as Error).message },
        'Failed to insert into DLQ — original error will be lost',
      );
    }
  };
}
