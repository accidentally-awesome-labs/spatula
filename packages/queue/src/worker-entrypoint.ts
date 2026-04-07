// packages/queue/src/worker-entrypoint.ts
// Standalone executable — NOT exported from the barrel (index.ts).
// Run via: node dist/worker-entrypoint.js

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createLogger, loadConfig } from '@spatula/shared';
import { createDatabasePool, DlqRepository } from '@spatula/db';
import { createDlqHandler } from './dlq-handler.js';
import { processCrawlJob } from './workers/crawl-worker.js';
import { processSchemaEvolutionJob } from './workers/schema-worker.js';
import { processReconciliationJob } from './workers/reconciliation-worker.js';
import { processExportJob } from './workers/export-worker.js';
import { QUEUE_NAMES, DEFAULT_QUEUE_CONFIG, createQueues } from './queues.js';
import { parseEnabledWorkers, isWorkerEnabled } from './worker-selection.js';
import { WorkerHeartbeat } from './worker-heartbeat.js';
import { createWebhookWorker } from './webhook-worker.js';
import { processMeteringJob } from './metering-worker.js';
import type { MeteringDeps } from './metering-worker.js';
import { processCleanupJob } from './cleanup-worker.js';
import type { CleanupDeps } from './cleanup-worker.js';
import type { WorkerDeps } from './worker-deps.js';
import type { CrawlJobData, SchemaEvolutionJobData, ReconciliationJobData, ExportJobPayload } from './queues.js';

const logger = createLogger('worker-entrypoint');

async function main() {
  const config = loadConfig();
  const redisUrl = config.redis.url;

  // Parse Redis URL into host/port for BullMQ ConnectionOptions.
  // We use parsed options rather than an ioredis instance to avoid
  // version-mismatch issues between our ioredis and BullMQ's bundled one.
  const redisUrlObj = new URL(redisUrl);
  const redisOpts = {
    host: redisUrlObj.hostname,
    port: parseInt(redisUrlObj.port, 10) || 6379,
    ...(redisUrlObj.password ? { password: decodeURIComponent(redisUrlObj.password) } : {}),
    ...(redisUrlObj.username ? { username: decodeURIComponent(redisUrlObj.username) } : {}),
  };

  // BullMQ Workers require maxRetriesPerRequest: null
  const workerConnection = { ...redisOpts, maxRetriesPerRequest: null as null };

  // Separate Redis connection for schema evolution distributed locks.
  // This uses normal settings (not maxRetriesPerRequest: null) because
  // lock semantics need proper retry behavior.
  const redisForLock = new Redis(redisUrl);

  const { db, pool } = createDatabasePool();
  const dlqRepo = new DlqRepository(db);
  const dlqHandler = createDlqHandler(dlqRepo);

  // Create queues (for enqueuing child jobs from crawl worker)
  const queues = createQueues(redisOpts);

  // NOTE: The actual repository and service construction depends on
  // which implementations are available. This is a minimal scaffold
  // that creates the infrastructure. Full DI wiring (crawler, extractor,
  // classifier, schemaEvolver, reconciler, linkEvaluator) requires
  // the core service factories which will be formalized in Wave 2.
  //
  // For now, the entry point demonstrates the lifecycle pattern.
  // Workers that require uninitialized services will log an error
  // and skip processing until services are wired.

  // Determine which workers to run (default: all)
  const enabledWorkers = parseEnabledWorkers(process.env.SPATULA_WORKERS);
  const isEnabled = (name: string) => isWorkerEnabled(enabledWorkers, name);

  const queueConfig = DEFAULT_QUEUE_CONFIG;
  const workers: Worker[] = [];

  // The WorkerDeps object will be constructed here once full DI is wired.
  // For the lifecycle scaffold, processors call the real functions with
  // deps passed via closure. The deps object is built by the deployer.
  let deps: WorkerDeps | undefined;

  if (isEnabled('crawl')) {
    const worker = new Worker<CrawlJobData>(
      QUEUE_NAMES.CRAWL,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processCrawlJob(job.data, deps);
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.crawl.concurrency,
        limiter: {
          max: queueConfig.crawl.rateLimitMax,
          duration: queueConfig.crawl.rateLimitDuration,
        },
      },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.CRAWL, concurrency: queueConfig.crawl.concurrency }, 'Crawl worker started');
  }

  if (isEnabled('schema-evolution')) {
    const worker = new Worker<SchemaEvolutionJobData>(
      QUEUE_NAMES.SCHEMA_EVOLUTION,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processSchemaEvolutionJob(job.data, deps, redisForLock);
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.schemaEvolution.concurrency,
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
        await processReconciliationJob(job.data, deps);
      },
      {
        connection: workerConnection,
        concurrency: queueConfig.reconciliation.concurrency,
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

  let meteringQueue: import('bullmq').Queue | undefined;
  if (isEnabled('metering')) {
    const { Queue: BullQueue } = await import('bullmq');
    meteringQueue = new BullQueue(QUEUE_NAMES.METERING, { connection: redisOpts });

    // Add repeatable job (hourly)
    await meteringQueue.add('metering', {}, {
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });

    // MeteringDeps is constructed lazily from worker-level deps when they become available.
    // Unlike other workers that receive WorkerDeps directly, the metering worker
    // needs repos + stripe client which may not be in WorkerDeps yet.
    // The worker will log a warning and skip if deps are not available.
    const worker = new Worker(
      QUEUE_NAMES.METERING,
      async () => {
        if (!deps) {
          logger.warn('Metering skipped — WorkerDeps not initialized');
          return;
        }
        // Construct MeteringDeps from available worker deps.
        // The metering worker requires usageRecordRepo, tenantRepo, and stripeClient
        // which are wired into deps by the deployer alongside other repos.
        const meteringDeps: MeteringDeps = {
          usageRecordRepo: (deps as any).usageRecordRepo,
          tenantRepo: (deps as any).tenantRepo,
          stripeClient: (deps as any).stripeClient ?? { isConfigured: () => false, reportUsage: async () => {} },
        };
        if (!meteringDeps.usageRecordRepo || !meteringDeps.tenantRepo) {
          logger.warn('Metering skipped — required repos not available in WorkerDeps');
          return;
        }
        await processMeteringJob(meteringDeps);
      },
      { connection: workerConnection, concurrency: 1 },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.METERING }, 'Metering worker started (hourly)');
  }

  let cleanupQueue: import('bullmq').Queue | undefined;
  if (isEnabled('cleanup')) {
    const { Queue: BullQueue } = await import('bullmq');
    cleanupQueue = new BullQueue(QUEUE_NAMES.CLEANUP, { connection: redisOpts });

    // Add repeatable job (daily at 03:00 UTC)
    await cleanupQueue.add('cleanup', {}, {
      repeat: { pattern: '0 3 * * *' },
      removeOnComplete: true,
      removeOnFail: 100,
    });

    const worker = new Worker(
      QUEUE_NAMES.CLEANUP,
      async () => {
        if (!deps) {
          logger.warn('Cleanup skipped — WorkerDeps not initialized');
          return;
        }
        // CleanupDeps.db needs execute() — the Drizzle db instance has this
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
      { connection: workerConnection, concurrency: 1 },
    );
    worker.on('failed', (job, err) => void dlqHandler(job, err));
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.CLEANUP }, 'Cleanup worker started (daily 03:00 UTC)');
  }

  // NOTE: No worker for QUEUE_NAMES.EXTRACT — extraction is performed
  // inline by the crawl worker. The extract queue exists for future use.

  logger.info({ workers: workers.length, enabled: enabledWorkers }, 'Worker entrypoint started');

  // Start heartbeat so the admin /workers endpoint can detect this process
  const enabledQueueNames = Object.entries({
    crawl: QUEUE_NAMES.CRAWL,
    'schema-evolution': QUEUE_NAMES.SCHEMA_EVOLUTION,
    reconciliation: QUEUE_NAMES.RECONCILIATION,
    export: QUEUE_NAMES.EXPORT,
    webhook: QUEUE_NAMES.WEBHOOK,
    metering: QUEUE_NAMES.METERING,
    cleanup: QUEUE_NAMES.CLEANUP,
  })
    .filter(([name]) => isEnabled(name))
    .map(([, queueName]) => queueName);

  const heartbeat = new WorkerHeartbeat({ redis: redisForLock, queues: enabledQueueNames });
  heartbeat.start();

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Worker shutdown initiated');

    try {
      // 1. Stop heartbeat so the worker is removed from the active list
      heartbeat.stop();

      // 2. BullMQ Worker.close() waits for current job to finish,
      //    then releases lock and stops picking up new jobs
      await Promise.allSettled(workers.map((w) => w.close()));
      logger.info('All workers closed');

      // 3. Close crawler (prevents orphaned browser processes)
      if (deps?.crawler) {
        await deps.crawler.close();
      }

      // 4. Close queues (stops enqueuing)
      await queues.closeAll();
      if (meteringQueue) await meteringQueue.close();
      if (cleanupQueue) await cleanupQueue.close();

      // 5. Close Redis connections
      // Worker connections are closed by Worker.close() above.
      // Only the separate lock connection needs explicit cleanup.
      await redisForLock.quit();

      // 6. Close database pool
      await pool.end();

      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Worker entrypoint failed to start');
  process.exit(1);
});
