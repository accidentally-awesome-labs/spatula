import { processReconciliation } from '@spatula/core';
import { enqueueWebhookIfConfigured } from '../webhook-sender.js';
import type { ReconciliationJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processReconciliationJob(
  data: ReconciliationJobData,
  deps: WorkerDeps,
): Promise<void> {
  const result = await processReconciliation(
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

  // Fire webhook: job.completed (reconciliation marks the job as complete)
  if (deps.queues?.webhook) {
    const job = await deps.jobRepo.findById(data.jobId, data.tenantId);
    enqueueWebhookIfConfigured(
      deps.queues.webhook,
      (job?.config as any)?.webhooks,
      'job.completed',
      { jobId: data.jobId, tenantId: data.tenantId, status: 'completed', entityCount: result.entitiesCreated },
    );
  }
}
