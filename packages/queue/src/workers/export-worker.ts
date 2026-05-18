import { processExport } from '@spatula/core';
import { enqueueWebhookIfConfigured } from '../webhook-sender.js';
import type { ExportJobPayload } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processExportJob(data: ExportJobPayload, deps: WorkerDeps): Promise<void> {
  await processExport(data, deps);

  // Fire webhook: export.completed
  if (deps.queues?.webhook) {
    const job = await deps.jobRepo.findById(data.jobId, data.tenantId);
    enqueueWebhookIfConfigured(
      deps.queues.webhook,
      (job?.config as any)?.webhooks,
      'export.completed',
      { jobId: data.jobId, tenantId: data.tenantId },
    );
  }
}
