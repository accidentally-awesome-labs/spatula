import { createLogger } from '@spatula/shared';
import { applySchemaActions } from '@spatula/core';
import type { JobConfig } from '@spatula/core';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('schema-worker');

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
): Promise<void> {
  const { jobId, tenantId } = data;

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

    // 7. Apply actions to create new schema version
    const evolvedSchema = applySchemaActions(currentSchema.definition, actions);
    if (evolvedSchema.version === currentSchema.definition.version) {
      logger.debug({ jobId }, 'no effective schema changes after applying actions');
      return;
    }

    // 8. Persist new schema version
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
  } catch (error) {
    logger.error({ jobId, error }, 'schema evolution job failed');
    // Don't rethrow -- failed evolution shouldn't crash the worker
  }
}
