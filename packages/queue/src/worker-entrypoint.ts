// packages/queue/src/worker-entrypoint.ts
// Exports startWorker() for embedded/programmatic use.
// Also runnable as a standalone process: node dist/worker-entrypoint.js

import { pathToFileURL } from 'node:url';
import { Worker, type Queue as BullQueueType } from 'bullmq';
import Redis from 'ioredis';
import { createLogger, loadConfig } from '@spatula/shared';
import {
  createDatabasePool,
  DlqRepository,
  TenantDataRepository,
  LlmUsageRepository,
} from '@spatula/db';
import { createDlqHandler } from './dlq-handler.js';
import { processCrawlJob } from './workers/crawl-worker.js';
import { processSchemaEvolutionJob } from './workers/schema-worker.js';
import { processReconciliationJob } from './workers/reconciliation-worker.js';
import { processExportJob } from './workers/export-worker.js';
import {
  QUEUE_NAMES,
  DEFAULT_QUEUE_CONFIG,
  createQueues,
  redisConnectionOptionsFromUrl,
} from './queues.js';
import { parseEnabledWorkers, isWorkerEnabled } from './worker-selection.js';
import { WorkerHeartbeat } from './worker-heartbeat.js';
import { createWebhookWorker } from './webhook-worker.js';
import { RedisEventPublisher } from './events.js';
import { processCleanupJob } from './cleanup-worker.js';
import type { CleanupDeps } from './cleanup-worker.js';
import { processTenantDeleteJob } from './workers/tenant-delete-worker.js';
import type { WorkerDeps } from './worker-deps.js';
import { buildWorkerDeps } from './build-worker-deps.js';
import type { BuildWorkerDepsResult } from './build-worker-deps.js';
import { usageContext } from './usage-context.js';
import { AlsUsageRecorder } from './als-usage-recorder.js';
import type {
  CrawlJobData,
  SchemaEvolutionJobData,
  ReconciliationJobData,
  ExportJobPayload,
  TenantDeleteJobData,
} from './queues.js';

const logger = createLogger('worker-entrypoint');
const WORKER_LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Handle returned by startWorker(). Call shutdown() to drain in-flight jobs
 * and release all resources. Does NOT call process.exit — the caller is
 * responsible for that (the standalone main() wrapper does it).
 */
export interface WorkerHandle {
  shutdown: () => Promise<void>;
}

/**
 * Start the BullMQ workers, heartbeat, and supporting infrastructure.
 * Returns a handle with a shutdown() method. Safe to import and call
 * from the API bootstrap (no process.exit called, no signal handlers registered).
 */
export async function startWorker(_opts?: { deps?: WorkerDeps }): Promise<WorkerHandle> {
  const config = loadConfig();
  const redisUrl = config.redis.url;

  const redisOpts = redisConnectionOptionsFromUrl(redisUrl);

  // BullMQ Workers require maxRetriesPerRequest: null
  const workerConnection = { ...redisOpts, maxRetriesPerRequest: null as null };

  // Separate Redis connection for schema evolution distributed locks.
  const redisForLock = new Redis(redisUrl);
  let redisForEvents: Redis | undefined;

  const { db, pool } = createDatabasePool();
  const dlqRepo = new DlqRepository(db);
  const dlqHandler = createDlqHandler(dlqRepo);

  // Create queues (for enqueuing child jobs from crawl worker)
  const queues = createQueues(redisOpts);

  // Determine which workers to run (default: all)
  const enabledWorkers = parseEnabledWorkers(process.env.SPATULA_WORKERS);
  const isEnabled = (name: string) => isWorkerEnabled(enabledWorkers, name);

  const queueConfig = DEFAULT_QUEUE_CONFIG;
  const workers: Worker[] = [];

  // Build (or inject for tests) the full WorkerDeps. Without this the handlers
  // below throw 'WorkerDeps not initialized' (the Gap-1 bug this fixes).
  // Keep `built` in scope so Plans 02/03 can read built.rawClient / built.llmClient / built.llmConfig.
  let built: BuildWorkerDepsResult | undefined;
  let deps: WorkerDeps;
  if (_opts?.deps) {
    deps = _opts.deps;
  } else {
    redisForEvents = new Redis(redisUrl);
    built = await buildWorkerDeps({
      db,
      pool,
      queues,
      eventPublisher: new RedisEventPublisher(redisForEvents),
    });
    deps = built.deps;
  }

  // Wire LLM usage recording onto the RAW client (CircuitBreaker wrapper does
  // not expose setUsageRecorder). ALS gives race-safe per-job attribution.
  if (built?.rawClient && 'setUsageRecorder' in built.rawClient) {
    const llmUsageRepo = new LlmUsageRepository(db);
    (built.rawClient as { setUsageRecorder: (r: AlsUsageRecorder) => void }).setUsageRecorder(
      new AlsUsageRecorder(llmUsageRepo),
    );
    logger.info('LLM usage recorder wired (ALS per-job attribution)');
  }

  // Per-job-derivation seam: attach the shared CircuitBreaker-wrapped
  // llmClient and the default config onto deps so each handler can call
  // resolveJobDeps(deps, (deps as any).llmClient, jobId, tenantId) without
  // changing the public WorkerDeps type or adding constructor parameters.
  // These are NOT enumerated on WorkerDeps — they're attached as plain properties.
  if (built?.llmClient) {
    (deps as any).llmClient = built.llmClient;
    (deps as any).defaultLlmConfig = built.llmConfig;
  }

  if (isEnabled('crawl')) {
    const worker = new Worker<CrawlJobData>(
      QUEUE_NAMES.CRAWL,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await usageContext.run({ tenantId: job.data.tenantId, jobId: job.data.jobId }, () =>
          processCrawlJob(job.data, deps),
        );
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.crawl.concurrency,
        lockDuration: WORKER_LOCK_DURATION_MS,
        limiter: {
          max: queueConfig.crawl.rateLimitMax,
          duration: queueConfig.crawl.rateLimitDuration,
        },
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info(
      { queue: QUEUE_NAMES.CRAWL, concurrency: queueConfig.crawl.concurrency },
      'Crawl worker started',
    );
  }

  if (isEnabled('schema-evolution')) {
    const worker = new Worker<SchemaEvolutionJobData>(
      QUEUE_NAMES.SCHEMA_EVOLUTION,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await usageContext.run({ tenantId: job.data.tenantId, jobId: job.data.jobId }, () =>
          processSchemaEvolutionJob(job.data, deps, redisForLock),
        );
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.schemaEvolution.concurrency,
        lockDuration: WORKER_LOCK_DURATION_MS,
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.SCHEMA_EVOLUTION }, 'Schema evolution worker started');
  }

  if (isEnabled('reconciliation')) {
    const worker = new Worker<ReconciliationJobData>(
      QUEUE_NAMES.RECONCILIATION,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await usageContext.run({ tenantId: job.data.tenantId, jobId: job.data.jobId }, () =>
          processReconciliationJob(job.data, deps),
        );
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.reconciliation.concurrency,
        lockDuration: WORKER_LOCK_DURATION_MS,
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.RECONCILIATION }, 'Reconciliation worker started');
  }

  if (isEnabled('export')) {
    const worker = new Worker<ExportJobPayload>(
      QUEUE_NAMES.EXPORT,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processExportJob(job.data, deps);
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.export.concurrency,
        lockDuration: WORKER_LOCK_DURATION_MS,
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.EXPORT }, 'Export worker started');
  }

  if (isEnabled('webhook')) {
    const webhookWorker = createWebhookWorker(workerConnection);
    webhookWorker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(webhookWorker);
    logger.info({ queue: QUEUE_NAMES.WEBHOOK }, 'Webhook worker started');
  }

  let cleanupQueue: BullQueueType | undefined;
  if (isEnabled('cleanup')) {
    const { Queue: BullQueue } = await import('bullmq');
    cleanupQueue = new BullQueue(QUEUE_NAMES.CLEANUP, { connection: redisOpts });

    await cleanupQueue.add(
      'cleanup',
      {},
      {
        repeat: { pattern: '0 3 * * *' },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    const worker = new Worker(
      QUEUE_NAMES.CLEANUP,
      async () => {
        if (!deps) {
          logger.warn('Cleanup skipped — WorkerDeps not initialized');
          return;
        }
        const dbInstance = (deps as any).db ?? (deps as any).jobRepo?.db;
        const cleanupDeps: CleanupDeps = {
          db: dbInstance,
          tenantRepo: (deps as any).tenantRepo,
          contentStore: (deps as any).contentStore,
        };
        if (!cleanupDeps.db || !cleanupDeps.tenantRepo) {
          logger.warn('Cleanup skipped — required deps not available in WorkerDeps');
          return;
        }
        await processCleanupJob(cleanupDeps);
      },
      { connection: workerConnection, concurrency: 1, lockDuration: WORKER_LOCK_DURATION_MS },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.CLEANUP }, 'Cleanup worker started (daily 03:00 UTC)');
  }

  if (isEnabled('tenant-delete')) {
    const worker = new Worker<TenantDeleteJobData>(
      QUEUE_NAMES.TENANT_DELETE,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        const tenantDataRepo = (deps as any).tenantDataRepo ?? new TenantDataRepository(db);
        await processTenantDeleteJob(job.data, {
          tenantDataRepo,
          contentStore: deps.contentStore,
          db: db as any,
        });
      },
      {
        connection: workerConnection,
        concurrency: 1,
        lockDuration: WORKER_LOCK_DURATION_MS,
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.TENANT_DELETE }, 'Tenant-delete worker started');
  }

  logger.info({ workers: workers.length, enabled: enabledWorkers }, 'Worker entrypoint started');

  // Start heartbeat
  const enabledQueueNames = Object.entries({
    crawl: QUEUE_NAMES.CRAWL,
    'schema-evolution': QUEUE_NAMES.SCHEMA_EVOLUTION,
    reconciliation: QUEUE_NAMES.RECONCILIATION,
    export: QUEUE_NAMES.EXPORT,
    webhook: QUEUE_NAMES.WEBHOOK,
    cleanup: QUEUE_NAMES.CLEANUP,
    'tenant-delete': QUEUE_NAMES.TENANT_DELETE,
  })
    .filter(([name]) => isEnabled(name))
    .map(([, queueName]) => queueName);

  const heartbeat = new WorkerHeartbeat({ redis: redisForLock, queues: enabledQueueNames });
  heartbeat.start();

  return {
    shutdown: async () => {
      // 1. Stop heartbeat
      heartbeat.stop();

      // 2. BullMQ Worker.close() waits for current job to finish
      await Promise.allSettled(workers.map((w) => w.close()));
      logger.info('All workers closed');

      // 3. Close crawler (prevents orphaned browser processes)
      if (deps?.crawler) {
        await deps.crawler.close();
      }

      // 4. Close queues
      await queues.closeAll();
      if (cleanupQueue) await cleanupQueue.close();

      // 5. Close Redis connections
      if (redisForEvents) await redisForEvents.quit();
      await redisForLock.quit();

      // 6. Close database pool
      await pool.end();

      logger.info('Worker shutdown complete');
      // NOTE: No process.exit here — caller is responsible.
    },
  };
}

/**
 * Standalone entry point. Calls startWorker(), registers OS signal handlers,
 * and exits when done. Only executed when this file is the process entry point.
 */
async function main() {
  const handle = await startWorker();
  let shuttingDown = false;

  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutdown initiated');
    try {
      await handle.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

// Guard: only run main() when this file is the process entry point, not when
// imported by the API bootstrap for embedded use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error({ err }, 'Worker entrypoint failed to start');
    process.exit(1);
  });
}
