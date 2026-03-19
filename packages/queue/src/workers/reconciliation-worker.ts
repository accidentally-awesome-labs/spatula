import { createLogger } from '@spatula/shared';
import type { JobConfig, ReconciliationConfig } from '@spatula/core';
import type { ExtractionWithSource } from '@spatula/core';
import type { ReconciliationJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('reconciliation-worker');

const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  matchStrategy: 'composite_key',
  conflictResolution: 'most_complete',
  fuzzyMatchThreshold: 0.85,
  enableLLMMatching: true,
};

export async function processReconciliationJob(
  data: ReconciliationJobData,
  deps: WorkerDeps,
): Promise<void> {
  const { jobId, tenantId } = data;

  try {
    // 1. Load job config
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping reconciliation');
      return;
    }
    const config = job.config as JobConfig;

    // 2. Load latest schema
    const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!currentSchema) {
      logger.warn({ jobId }, 'no schema found, skipping reconciliation');
      return;
    }

    // 3. Load all extractions
    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId);
    if (extractions.length === 0) {
      logger.warn({ jobId }, 'no extractions found, skipping reconciliation');
      await deps.jobRepo.updateStatus(jobId, tenantId, 'completed');
      return;
    }

    // 4. Load pages for enrichment
    const uniquePageIds = [...new Set(extractions.map((e: { pageId: string }) => e.pageId))];
    const pages = await deps.pageRepo.findByIds(uniquePageIds, tenantId);
    const pageMap = new Map(pages.map((p: { id: string }) => [p.id, p]));

    // 5. Enrich extractions with page metadata
    const enriched: ExtractionWithSource[] = extractions.map(
      (ext: {
        id: string;
        jobId: string;
        pageId: string;
        schemaVersion: number;
        data: unknown;
        metadata: unknown;
      }) => {
        const page = pageMap.get(ext.pageId) as
          | {
              metadata: Record<string, unknown>;
              createdAt: Date;
            }
          | undefined;
        const sourceUrl = (page?.metadata?.url as string) || `https://unknown/${ext.pageId}`;
        const sourceDomain = new URL(sourceUrl).hostname;
        const crawledAt = page?.createdAt || new Date();

        return {
          id: ext.id,
          jobId: ext.jobId,
          pageId: ext.pageId,
          schemaVersion: ext.schemaVersion,
          data: ext.data as Record<string, unknown>,
          metadata: ext.metadata as {
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
          sourceUrl,
          sourceDomain,
          crawledAt,
        };
      },
    );

    // 6. Reconcile
    const reconciliationConfig = config.reconciliation ?? DEFAULT_RECONCILIATION_CONFIG;
    const result = await deps.reconciler.reconcile(
      enriched,
      currentSchema.definition,
      reconciliationConfig,
      config.description,
    );

    // 7. Stamp jobId on all actions
    for (const action of result.actions) {
      action.jobId = jobId;
    }

    // 8. Persist entities and link extractions
    for (const entity of result.entities) {
      const dbEntity = await deps.entityRepo.create({
        jobId,
        tenantId,
        mergedData: entity.mergedData,
        provenance: entity.fieldProvenance,
        qualityScore: entity.sourceExtractions.length / extractions.length,
      });

      // Link extractions to this entity
      const links = entity.sourceExtractions.map((src: { extractionId: string }) => ({
        entityId: dbEntity.id,
        extractionId: src.extractionId,
        matchConfidence: 1.0,
      }));
      await deps.entitySourceRepo.bulkLink(links);

      // Publish entity_created event
      await deps.eventPublisher?.publish(jobId, {
        type: 'entity_created',
        jobId,
        tenantId,
        data: {
          entityId: dbEntity.id,
          name: String(entity.mergedData.name ?? entity.mergedData.title ?? `Entity ${dbEntity.id.slice(0, 8)}`),
        },
      });
    }

    // 9. Persist source trust from set_source_trust actions
    for (const action of result.actions) {
      if (action.type === 'set_source_trust') {
        const payload = action.payload as {
          rankings: Array<{
            domain: string;
            trustLevel: string;
            reasoning: string;
          }>;
        };
        for (const ranking of payload.rankings) {
          await deps.sourceTrustRepo.upsert({
            jobId,
            tenantId,
            domain: ranking.domain,
            trustLevel: ranking.trustLevel as 'authoritative' | 'high' | 'medium' | 'low',
            reasoning: ranking.reasoning,
          });
        }
      }
    }

    // 10. Update job status to completed
    await deps.jobRepo.updateStatus(jobId, tenantId, 'completed');

    // Publish job_status_changed event
    await deps.eventPublisher?.publish(jobId, {
      type: 'job_status_changed',
      jobId,
      tenantId,
      data: { from: 'reconciling', to: 'completed' },
    });

    logger.info(
      {
        jobId,
        entitiesCreated: result.entities.length,
        actionsGenerated: result.actions.length,
      },
      'reconciliation completed',
    );
  } catch (error) {
    logger.error({ jobId, error }, 'reconciliation job failed');
    await deps.jobRepo.updateStatus(jobId, tenantId, 'failed').catch((e: unknown) => {
      logger.error({ jobId, error: e }, 'failed to mark job as failed');
    });
    // Don't rethrow -- failed reconciliation shouldn't crash the worker
  }
}
