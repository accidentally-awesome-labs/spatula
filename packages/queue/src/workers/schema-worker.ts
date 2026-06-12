import { createLoggerWithContext } from '@spatula/shared';
import { processSchemaEvolution } from '@spatula/core';
import type { LLMClient } from '@spatula/core';
import type Redis from 'ioredis';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';
import { acquireLock, releaseLock } from '../redis-lock.js';
import { enqueueWebhookIfConfigured } from '../webhook-sender.js';
import { resolveJobDeps } from '../derive-job-deps.js';

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
  redis?: Redis,
): Promise<void> {
  const logger = createLoggerWithContext('schema-worker', {
    jobId: data.jobId,
    tenantId: data.tenantId,
  });
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

  // Derive per-job deps from the job's LLMConfig over the shared llmClient.
  // Falls back to base deps when no llmClient is threaded (test-injection path).
  const sharedClient = (deps as any).llmClient as LLMClient | undefined;
  const jobDeps = await resolveJobDeps(deps, sharedClient, data.jobId, data.tenantId);

  try {
    const result = await processSchemaEvolution(
      { jobId: data.jobId, tenantId: data.tenantId, extractionIds: data.extractionIds },
      {
        schemaEvolver: jobDeps.schemaEvolver,
        jobRepo: jobDeps.jobRepo,
        extractionRepo: jobDeps.extractionRepo,
        schemaRepo: jobDeps.schemaRepo,
        actionRepo: jobDeps.actionRepo,
        eventPublisher: jobDeps.eventPublisher,
      },
    );

    // Fire webhook: action.pending (if schema evolution created review actions)
    if (result.actionsApplied > 0 && jobDeps.queues?.webhook) {
      const job = await jobDeps.jobRepo.findById(data.jobId, data.tenantId);
      enqueueWebhookIfConfigured(
        jobDeps.queues.webhook,
        (job?.config as any)?.webhooks,
        'action.pending',
        { jobId: data.jobId, tenantId: data.tenantId },
      );
    }
  } catch (error) {
    logger.error({ jobId: data.jobId, error }, 'schema evolution job failed');
  } finally {
    if (redis && lockToken) {
      await releaseLock(redis, lockKey, lockToken);
    }
  }
}
