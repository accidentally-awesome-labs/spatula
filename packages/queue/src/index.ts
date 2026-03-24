// State Machine
export { JobStateMachine } from './state-machine.js';
export { StateError } from '@spatula/shared';

// Queues
export { createQueues, QUEUE_NAMES, DEFAULT_QUEUE_CONFIG, QUEUE_JOB_OPTIONS } from './queues.js';
export type {
  CrawlJobData,
  ExtractJobData,
  SchemaEvolutionJobData,
  ReconciliationJobData,
  ExportJobPayload,
  SpatulaQueues,
  QueueConfig,
} from './queues.js';

// Job Manager
export { JobManager } from './job-manager.js';
export type { JobManagerConfig } from './job-manager.js';

// Worker Dependencies
export { WorkerDeps } from './worker-deps.js';
export type { WorkerDepsConfig } from './worker-deps.js';

// Redis Lock
export { acquireLock, releaseLock } from './redis-lock.js';

// Events
export { RedisEventPublisher, NoopEventPublisher, channelForJob } from './events.js';
export type { EventPublisher, JobEvent, JobEventType } from './events.js';

// Workers
export { processCrawlJob } from './workers/crawl-worker.js';
export { processSchemaEvolutionJob } from './workers/schema-worker.js';
export { processReconciliationJob } from './workers/reconciliation-worker.js';
export { processExportJob } from './workers/export-worker.js';
