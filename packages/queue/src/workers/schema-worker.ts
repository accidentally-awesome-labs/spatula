import { createLoggerWithContext } from '@spatula/shared';
import { processSchemaEvolution } from '@spatula/core';
import type Redis from 'ioredis';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';
import { acquireLock, releaseLock } from '../redis-lock.js';

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
  redis?: Redis,
): Promise<void> {
  const logger = createLoggerWithContext('schema-worker', { jobId: data.jobId, tenantId: data.tenantId });
  const lockKey = `schema-lock:${data.jobId}`;
  let lockToken = '';

  // Acquire distributed lock (queue-specific concern)
  if (redis) {
    const lock = await acquireLock(redis, lockKey, 30);
    if (!lock.acquired) {
      logger.debug({ jobId: data.jobId }, 'could not acquire schema evolution lock, skipping');
      return;
    }
    lockToken = lock.token;
  }

  try {
    await processSchemaEvolution(
      { jobId: data.jobId, tenantId: data.tenantId, extractionIds: data.extractionIds },
      {
        schemaEvolver: deps.schemaEvolver,
        jobRepo: deps.jobRepo,
        extractionRepo: deps.extractionRepo,
        schemaRepo: deps.schemaRepo,
        actionRepo: deps.actionRepo,
        eventPublisher: deps.eventPublisher,
      },
    );
  } catch (error) {
    logger.error({ jobId: data.jobId, error }, 'schema evolution job failed');
  } finally {
    if (redis && lockToken) {
      await releaseLock(redis, lockKey, lockToken);
    }
  }
}
