import { processExport } from '@spatula/core';
import type { ExportJobPayload } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processExportJob(
  data: ExportJobPayload,
  deps: WorkerDeps,
): Promise<void> {
  await processExport(data, deps);
}
