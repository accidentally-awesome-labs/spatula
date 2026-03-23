// packages/queue/src/worker-entrypoint.ts
// Standalone executable — NOT exported from the barrel (index.ts).
// Run via: node dist/worker-entrypoint.js

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createLogger, loadConfig } from '@spatula/shared';
import { createDatabasePool } from '@spatula/db';
import { processCrawlJob } from './workers/crawl-worker.js';
import { processSchemaEvolutionJob } from './workers/schema-worker.js';
import { processReconciliationJob } from './workers/reconciliation-worker.js';
import { processExportJob } from './workers/export-worker.js';
import { QUEUE_NAMES, DEFAULT_QUEUE_CONFIG, createQueues } from './queues.js';
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

  // db is not used yet — full DI wiring (repositories, content store)
  // will be added in Wave 2 when service factories are available.
  const { pool } = createDatabasePool();

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
  const enabledWorkers = (process.env.SPATULA_WORKERS ?? 'all')
    .split(',')
    .map((w) => w.trim().toLowerCase());
  const isEnabled = (name: string) =>
    enabledWorkers.includes('all') || enabledWorkers.includes(name);

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
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.EXPORT }, 'Export worker started');
  }

  // NOTE: No worker for QUEUE_NAMES.EXTRACT — extraction is performed
  // inline by the crawl worker. The extract queue exists for future use.

  logger.info({ workers: workers.length, enabled: enabledWorkers }, 'Worker entrypoint started');

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Worker shutdown initiated');

    try {
      // 1. BullMQ Worker.close() waits for current job to finish,
      //    then releases lock and stops picking up new jobs
      await Promise.allSettled(workers.map((w) => w.close()));
      logger.info('All workers closed');

      // 2. Close crawler (prevents orphaned browser processes)
      if (deps?.crawler) {
        await deps.crawler.close();
      }

      // 3. Close queues (stops enqueuing)
      await queues.closeAll();

      // 4. Close Redis connections
      // Worker connections are closed by Worker.close() above.
      // Only the separate lock connection needs explicit cleanup.
      await redisForLock.quit();

      // 5. Close database pool
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
