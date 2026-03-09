import { createLogger } from '@spatula/shared';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('schema-worker');

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  _deps: WorkerDeps,
): Promise<void> {
  logger.info(
    { jobId: data.jobId, extractionCount: data.extractionIds.length },
    'schema evolution job received — implementation in Phase 6',
  );
}
