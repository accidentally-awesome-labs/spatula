import { processReconciliation } from '@accidentally-awesome-labs/spatula-core';
import type { LLMClient } from '@accidentally-awesome-labs/spatula-core';
import { enqueueWebhookIfConfigured } from '../webhook-sender.js';
import type { ReconciliationJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';
import { resolveJobDeps } from '../derive-job-deps.js';

export async function processReconciliationJob(
  data: ReconciliationJobData,
  deps: WorkerDeps,
): Promise<void> {
  // Derive per-job deps from the job's LLMConfig over the shared llmClient.
  // Falls back to base deps when no llmClient is threaded (test-injection path).
  const sharedClient = (deps as any).llmClient as LLMClient | undefined;
  const jobDeps = await resolveJobDeps(deps, sharedClient, data.jobId, data.tenantId);

  const result = await processReconciliation(
    { jobId: data.jobId, tenantId: data.tenantId },
    {
      reconciler: jobDeps.reconciler,
      jobRepo: jobDeps.jobRepo,
      schemaRepo: jobDeps.schemaRepo,
      extractionRepo: jobDeps.extractionRepo,
      pageRepo: jobDeps.pageRepo,
      entityRepo: jobDeps.entityRepo,
      entitySourceRepo: jobDeps.entitySourceRepo,
      sourceTrustRepo: jobDeps.sourceTrustRepo,
      eventPublisher: jobDeps.eventPublisher,
    },
  );

  // Fire webhook: job.completed (reconciliation marks the job as complete)
  if (jobDeps.queues?.webhook) {
    const job = await jobDeps.jobRepo.findById(data.jobId, data.tenantId);
    enqueueWebhookIfConfigured(
      jobDeps.queues.webhook,
      (job?.config as any)?.webhooks,
      'job.completed',
      {
        jobId: data.jobId,
        tenantId: data.tenantId,
        status: 'completed',
        entityCount: result.entitiesCreated,
      },
    );
  }
}
