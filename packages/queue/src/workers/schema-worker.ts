import { createLoggerWithContext } from '@spatula/shared';
import { applySchemaActions } from '@spatula/core';
import type { JobConfig } from '@spatula/core';
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
  const { jobId, tenantId } = data;
  const lockKey = `schema-lock:${jobId}`;
  let lockToken = '';

  // Acquire distributed lock if Redis available
  if (redis) {
    const lock = await acquireLock(redis, lockKey, 30);
    if (!lock.acquired) {
      logger.debug({ jobId }, 'could not acquire schema evolution lock, skipping');
      return;
    }
    lockToken = lock.token;
  }

  try {
    // 1. Load job config
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping schema evolution');
      return;
    }

    const config = job.config as JobConfig;

    // 2. Check if evolution is enabled
    if (!config.schema.evolutionConfig?.enabled) {
      logger.debug({ jobId }, 'schema evolution not enabled, skipping');
      return;
    }

    // 3. Load current schema
    const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!currentSchema) {
      logger.debug({ jobId }, 'no schema found, skipping evolution');
      return;
    }

    // 4. Fetch recent extractions
    const batchSize = config.schema.evolutionConfig.batchSize ?? 10;
    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      limit: batchSize,
    });
    if (extractions.length === 0) {
      logger.debug({ jobId }, 'no extractions found, skipping evolution');
      return;
    }

    // 5. Map DB rows to ExtractionResult shape
    const extractionResults = extractions.map((e) => ({
      id: e.id,
      jobId: e.jobId,
      pageId: e.pageId,
      schemaVersion: e.schemaVersion,
      data: e.data as Record<string, unknown>,
      metadata: e.metadata as {
        confidence: number;
        modelUsed: string;
        tokensUsed: number;
        extractionTimeMs: number;
        unmappedFields: Array<{
          name: string;
          value: unknown;
          suggestedType: string;
        }>;
      },
    }));

    // 6. Call schema evolver
    const actions = await deps.schemaEvolver.evolve(
      currentSchema.definition,
      extractionResults,
      config.description,
    );

    if (actions.length === 0) {
      logger.debug({ jobId }, 'no evolution actions proposed');
      return;
    }

    // 7. Stamp the correct jobId on all actions (evolve() doesn't know the jobId)
    for (const action of actions) {
      action.jobId = jobId;
    }

    // 7b. Persist each action to the audit log
    for (const action of actions) {
      await deps.actionRepo.create({
        jobId,
        tenantId,
        type: action.type,
        payload: 'payload' in action ? (action as any).payload : {},
        source: action.source ?? 'schema_evolution',
        status: 'applied',
        confidence: action.confidence,
        reasoning: action.reasoning,
      });
    }

    // 8. Apply actions to create new schema version
    const evolvedSchema = applySchemaActions(currentSchema.definition, actions);
    if (evolvedSchema.version === currentSchema.definition.version) {
      logger.debug({ jobId }, 'no effective schema changes after applying actions');
      return;
    }

    // 9. Persist new schema version
    await deps.schemaRepo.create({
      jobId,
      tenantId,
      version: evolvedSchema.version,
      definition: evolvedSchema,
      parentId: currentSchema.id,
    });

    logger.info(
      { jobId, newVersion: evolvedSchema.version, actionsApplied: actions.length },
      'schema evolved',
    );

    // Publish schema_evolved event
    await deps.eventPublisher?.publish(jobId, {
      type: 'schema_evolved',
      jobId,
      tenantId,
      data: {
        version: evolvedSchema.version,
        fieldsAdded: actions.filter((a) => a.type === 'add_field').map((a) => (a as any).payload?.name ?? ''),
        fieldsMerged: actions.filter((a) => a.type === 'merge_fields').map((a) => (a as any).payload?.canonicalName ?? ''),
      },
    });
  } catch (error) {
    logger.error({ jobId, error }, 'schema evolution job failed');
    // Don't rethrow -- failed evolution shouldn't crash the worker
  } finally {
    if (redis && lockToken) {
      await releaseLock(redis, lockKey, lockToken);
    }
  }
}
