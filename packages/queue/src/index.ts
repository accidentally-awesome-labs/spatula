// State Machine
export { JobStateMachine, InvalidTransitionError } from './state-machine.js';

// Queues
export { createQueues, QUEUE_NAMES } from './queues.js';
export type {
  CrawlJobData,
  ExtractJobData,
  SchemaEvolutionJobData,
  ReconciliationJobData,
  SpatulaQueues,
} from './queues.js';

// Job Manager
export { JobManager } from './job-manager.js';
export type { JobManagerConfig } from './job-manager.js';

// Worker Dependencies
export { WorkerDeps } from './worker-deps.js';
export type { WorkerDepsConfig } from './worker-deps.js';

// Workers
export { processCrawlJob } from './workers/crawl-worker.js';
export { processSchemaEvolutionJob } from './workers/schema-worker.js';
export { processReconciliationJob } from './workers/reconciliation-worker.js';
