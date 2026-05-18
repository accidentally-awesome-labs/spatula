// packages/core/src/pipeline/schema-orchestrator.ts
import { createLoggerWithContext } from '@spatula/shared';
import { applySchemaActions } from '../index.js';
import type { JobConfig, PipelineAction } from '../index.js';
import type {
  SchemaOrchestratorDeps,
  SchemaEvolutionInput,
  SchemaEvolutionResult,
} from './types.js';

/**
 * Pure schema evolution logic. No BullMQ/Redis references.
 *
 * The caller is responsible for acquiring any distributed lock
 * before calling this function (server mode uses Redis lock,
 * local mode needs no lock since it's single-process).
 */
export async function processSchemaEvolution(
  input: SchemaEvolutionInput,
  deps: SchemaOrchestratorDeps,
): Promise<SchemaEvolutionResult> {
  const { jobId, tenantId } = input;
  const logger = createLoggerWithContext('schema-orchestrator', { jobId, tenantId });

  try {
    // 1. Load job config
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping schema evolution');
      return { evolved: false, actionsApplied: 0 };
    }

    const config = job.config as JobConfig;
    if (!config.schema.evolutionConfig?.enabled) {
      logger.debug({ jobId }, 'schema evolution not enabled, skipping');
      return { evolved: false, actionsApplied: 0 };
    }

    // 2. Load current schema
    const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!currentSchema) {
      logger.debug({ jobId }, 'no schema found, skipping evolution');
      return { evolved: false, actionsApplied: 0 };
    }

    // 3. Fetch recent extractions
    const batchSize = config.schema.evolutionConfig.batchSize ?? 10;
    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, { limit: batchSize });
    if (extractions.length === 0) {
      logger.debug({ jobId }, 'no extractions found, skipping evolution');
      return { evolved: false, actionsApplied: 0 };
    }

    // 4. Map DB rows to ExtractionResult shape
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
        unmappedFields: Array<{ name: string; value: unknown; suggestedType: string }>;
      },
    }));

    // 5. Call schema evolver
    const actions = await deps.schemaEvolver.evolve(
      currentSchema.definition,
      extractionResults,
      config.description,
    );

    if (actions.length === 0) {
      logger.debug({ jobId }, 'no evolution actions proposed');
      return { evolved: false, actionsApplied: 0 };
    }

    // 6. Stamp jobId on all actions
    for (const action of actions) {
      action.jobId = jobId;
    }

    // 7. Persist each action to the audit log
    for (const action of actions) {
      await deps.actionRepo.create({
        jobId,
        tenantId,
        type: action.type,
        payload: action.payload,
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
      return { evolved: false, actionsApplied: 0 };
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

    // 10. Publish event
    await deps.eventPublisher?.publish(jobId, {
      type: 'schema_evolved',
      jobId,
      tenantId,
      data: {
        version: evolvedSchema.version,
        fieldsAdded: actions
          .filter(
            (a): a is Extract<PipelineAction, { type: 'add_field' }> => a.type === 'add_field',
          )
          .map((a) => a.payload.field.name),
        fieldsMerged: actions
          .filter(
            (a): a is Extract<PipelineAction, { type: 'merge_fields' }> =>
              a.type === 'merge_fields',
          )
          .map((a) => a.payload.canonicalName),
      },
    });

    return {
      evolved: true,
      newVersion: evolvedSchema.version,
      actionsApplied: actions.length,
    };
  } catch (error) {
    logger.error({ jobId, error }, 'schema evolution failed');
    return { evolved: false, actionsApplied: 0 };
  }
}
