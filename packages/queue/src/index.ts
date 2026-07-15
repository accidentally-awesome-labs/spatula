// State Machine
export { JobStateMachine } from './state-machine.js';
export { StateError } from '@accidentally-awesome-labs/spatula-shared';

// Queues
export {
  createQueues,
  redisConnectionOptionsFromUrl,
  QUEUE_NAMES,
  DEFAULT_QUEUE_CONFIG,
  QUEUE_JOB_OPTIONS,
} from './queues.js';
export type {
  CrawlJobData,
  ExtractJobData,
  SchemaEvolutionJobData,
  ReconciliationJobData,
  ExportJobPayload,
  WebhookJobData,
  TenantDeleteJobData,
  SpatulaQueues,
  QueueConfig,
} from './queues.js';
// Re-export bullmq types consumers need so downstream packages don't have to
// depend on bullmq directly.
export type { Queue, Worker, Job } from 'bullmq';

// Webhook
export { WebhookSender, enqueueWebhookIfConfigured } from './webhook-sender.js';
export { createWebhookWorker } from './webhook-worker.js';

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

// DLQ Handler
export { createDlqHandler } from './dlq-handler.js';

// Trace Context Propagation
export { injectTraceContext, extractTraceContext } from './trace-context.js';

// Worker Heartbeat
export { WorkerHeartbeat } from './worker-heartbeat.js';
export type { HeartbeatConfig } from './worker-heartbeat.js';

// Workers
export { processCrawlJob } from './workers/crawl-worker.js';
export { processSchemaEvolutionJob } from './workers/schema-worker.js';
export { processReconciliationJob } from './workers/reconciliation-worker.js';
export { processExportJob } from './workers/export-worker.js';
export { processTenantDeleteJob } from './workers/tenant-delete-worker.js';
export type { TenantDeleteJobDeps } from './workers/tenant-delete-worker.js';

// Cleanup Worker
export { processCleanupJob } from './cleanup-worker.js';
export type { CleanupDeps, CleanupResult } from './cleanup-worker.js';

// Worker Entrypoint Lifecycle
export { startWorker } from './worker-entrypoint.js';
export type { WorkerHandle } from './worker-entrypoint.js';

// ALS Usage Context. The recorder is an internal worker implementation detail
// and intentionally stays out of the OSS public barrel.
export { usageContext, currentUsageContext } from './usage-context.js';
export type { UsageContext } from './usage-context.js';

// Per-job LLM config derivation
export { deriveJobDeps, resolveJobDeps } from './derive-job-deps.js';
