import { processReconciliation } from '@spatula/core';
import type { ReconciliationJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processReconciliationJob(
  data: ReconciliationJobData,
  deps: WorkerDeps,
): Promise<void> {
  await processReconciliation(
    { jobId: data.jobId, tenantId: data.tenantId },
    {
      reconciler: deps.reconciler,
      jobRepo: deps.jobRepo,
      schemaRepo: deps.schemaRepo,
      extractionRepo: deps.extractionRepo,
      pageRepo: deps.pageRepo,
      entityRepo: deps.entityRepo,
      entitySourceRepo: deps.entitySourceRepo,
      sourceTrustRepo: deps.sourceTrustRepo,
      eventPublisher: deps.eventPublisher,
    },
  );
}
