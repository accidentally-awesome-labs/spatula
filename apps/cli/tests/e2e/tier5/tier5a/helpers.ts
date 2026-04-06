/**
 * Tier 5A Test Helpers — Queue/Worker integration testing with real BullMQ workers.
 *
 * Wires the full worker dependency graph:
 *  - Real Postgres (repos) + Redis (BullMQ + general)
 *  - Mock Ollama + fixture HTTP server (deterministic LLM + crawl targets)
 *  - Playwright crawler
 *  - 5 BullMQ workers (crawl, schema-evolution, reconciliation, export, webhook)
 *  - Real JobManager with real queues
 *  - Hono API app via createApp(deps) for route testing
 *
 * Returns null when DATABASE_URL is missing or Playwright is unavailable,
 * allowing tests to skip gracefully.
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'bullmq';

import {
  createDatabasePool,
  JobRepository,
  SchemaRepository,
  ExtractionRepository,
  EntityRepository,
  EntitySourceRepository,
  ActionRepository,
  CrawlTaskRepository,
  ExportRepository,
  TenantRepository,
  DlqRepository,
  ApiKeyRepository,
  AuditLogRepository,
  LlmUsageRepository,
  PageRepository,
  SourceTrustRepository,
} from '@spatula/db';
import type { Database } from '@spatula/db';

import {
  CrawlerFactory,
  LocalContentStore,
  PageClassifier,
  StaticExtractor,
  SchemaEvolverImpl,
  DataReconcilerImpl,
  LLMLinkEvaluator,
  CrawlCompletionChecker,
  createLLMClient,
  resolveModel,
} from '@spatula/core';
import type { Crawler } from '@spatula/core';

import { AuditLogger } from '@spatula/shared';

import {
  createQueues,
  QUEUE_NAMES,
  WorkerDeps,
  JobManager,
  NoopEventPublisher,
  WebhookSender,
  createDlqHandler,
  processCrawlJob,
  processSchemaEvolutionJob,
  processReconciliationJob,
  processExportJob,
} from '@spatula/queue';
import type { SpatulaQueues } from '@spatula/queue';

import { isPlaywrightAvailable } from '../../tier2/helpers.js';
import { startFixtureServer } from '../../tier2/fixture-server.js';
import type { FixtureServer } from '../../tier2/fixture-server.js';
import { startMockOllama } from '../../tier2/mock-ollama.js';
import type { MockOllamaServer } from '../../tier2/mock-ollama.js';
import { startWebhookReceiver } from '../../tier4/helpers.js';
import type { WebhookReceiver } from '../../tier4/helpers.js';

// pg and ioredis types — structural to avoid extra devDependencies
type Pool = { end(): Promise<void>; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TestWorkerHarness {
  workers: Worker[];
  workerDeps: WorkerDeps;
  queues: SpatulaQueues;
  jobManager: JobManager;
  fixtureServer: FixtureServer;
  mockOllama: MockOllamaServer;
  webhookReceiver: WebhookReceiver;
  app: any; // Hono app for route testing
  tenantId: string;
  pool: Pool;
  db: Database;
  closeAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// startTestWorkers()
// ---------------------------------------------------------------------------

export async function startTestWorkers(opts: {
  databaseUrl: string;
  redisUrl: string;
}): Promise<TestWorkerHarness | null> {
  // 1. Guard: DATABASE_URL required
  if (!opts.databaseUrl) return null;

  // 2. Guard: Playwright must be available (crawler is REQUIRED for WorkerDeps)
  const pwAvailable = await isPlaywrightAvailable();
  if (!pwAvailable) return null;

  // 3. Start fixture server + mock Ollama
  const fixtureServer = await startFixtureServer();
  const mockOllama = await startMockOllama();

  // 4. Create Postgres pool + all repository instances
  const { db, pool } = createDatabasePool(opts.databaseUrl);
  const jobRepo = new JobRepository(db);
  const schemaRepo = new SchemaRepository(db);
  const extractionRepo = new ExtractionRepository(db);
  const entityRepo = new EntityRepository(db);
  const entitySourceRepo = new EntitySourceRepository(db);
  const actionRepo = new ActionRepository(db);
  const taskRepo = new CrawlTaskRepository(db);
  const exportRepo = new ExportRepository(db);
  const tenantRepo = new TenantRepository(db);
  const dlqRepo = new DlqRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const auditLogRepo = new AuditLogRepository(db);
  const llmUsageRepo = new LlmUsageRepository(db);
  const pageRepo = new PageRepository(db);
  const sourceTrustRepo = new SourceTrustRepository(db);

  // 5. Create BullMQ Redis connection (maxRetriesPerRequest: null required by BullMQ)
  const redisModule = 'ioredis';
  const mod: any = await import(/* @vite-ignore */ redisModule);
  const IoRedis = mod.default;

  const bullmqRedisConnection = {
    host: 'localhost',
    port: 6380,
    db: 1,
    maxRetriesPerRequest: null as null,
  };

  // 6. Create separate ioredis client for general Redis operations
  const redis = new IoRedis('localhost', {
    port: 6380,
    db: 1,
  });

  // Flush Redis db 1 to clear stale BullMQ jobs
  await redis.flushdb();

  // 7. Create SpatulaQueues
  const queues = createQueues(bullmqRedisConnection);

  // 8. Create DLQ handler
  const dlqHandler = createDlqHandler(dlqRepo);

  // 9. Build LLM components from mock Ollama (same pattern as Tier 2)
  const llmClient = createLLMClient({
    provider: 'ollama',
    ollama: { baseUrl: `http://localhost:${mockOllama.port}` },
  });
  const llmConfig = { primaryModel: 'llama3.2:1b' };

  const classifier = new PageClassifier(llmClient, llmConfig);
  const extractor = new StaticExtractor(llmClient, llmConfig, 'tier5a-test');
  const schemaEvolver = new SchemaEvolverImpl(llmClient, llmConfig);
  const reconciler = new DataReconcilerImpl(llmClient, llmConfig);
  const linkEvaluator = new LLMLinkEvaluator(llmClient, resolveModel(llmConfig, 'linkEvaluation'));

  // 10. Create Playwright crawler
  const crawler: Crawler = await CrawlerFactory.create({ type: 'playwright' });

  // 11. Create LocalContentStore pointed at temp dir
  const contentDir = mkdtempSync(join(tmpdir(), 'spatula-tier5a-content-'));
  const contentStore = new LocalContentStore(contentDir);

  // 12. Create CrawlCompletionChecker — CRITICAL: without this, jobs never complete
  const completionChecker = new CrawlCompletionChecker();

  // 13. Create AuditLogger
  const auditLogger = new AuditLogger(auditLogRepo);

  // 14. Create WorkerDeps with ALL required fields
  const workerDeps = new WorkerDeps({
    dbPool: pool,
    crawler,
    extractor,
    classifier,
    contentStore,
    schemaEvolver,
    reconciler: reconciler,
    jobRepo,
    taskRepo,
    pageRepo,
    extractionRepo,
    schemaRepo,
    entityRepo,
    sourceTrustRepo,
    entitySourceRepo,
    exportRepo,
    actionRepo,
    eventPublisher: new NoopEventPublisher(),
    linkEvaluator,
    completionChecker,
    tenantRepo,
    queues,
  });

  // 15. Create 5 BullMQ Workers with concurrency 1
  const crawlWorker = new Worker(
    QUEUE_NAMES.CRAWL,
    async (job) => processCrawlJob(job.data, workerDeps),
    { connection: bullmqRedisConnection, concurrency: 1 },
  );

  const schemaWorker = new Worker(
    QUEUE_NAMES.SCHEMA_EVOLUTION,
    async (job) => processSchemaEvolutionJob(job.data, workerDeps),
    { connection: bullmqRedisConnection, concurrency: 1 },
  );

  const reconciliationWorker = new Worker(
    QUEUE_NAMES.RECONCILIATION,
    async (job) => processReconciliationJob(job.data, workerDeps),
    { connection: bullmqRedisConnection, concurrency: 1 },
  );

  const exportWorker = new Worker(
    QUEUE_NAMES.EXPORT,
    async (job) => processExportJob(job.data, workerDeps),
    { connection: bullmqRedisConnection, concurrency: 1 },
  );

  // Webhook worker: created directly (not via createWebhookWorker which hardcodes backoff)
  const webhookWorker = new Worker(
    QUEUE_NAMES.WEBHOOK,
    async (job) => {
      const sender = new WebhookSender();
      await sender.send(job.data.url, job.data.event, job.data.secret);
    },
    { connection: bullmqRedisConnection, concurrency: 1 },
  );

  const workers = [crawlWorker, schemaWorker, reconciliationWorker, exportWorker, webhookWorker];

  // 16. Attach DLQ handler to each worker
  for (const worker of workers) {
    worker.on('failed', dlqHandler);
  }

  // 17. Create JobManager with real queues
  const jobManager = new JobManager({
    jobRepo,
    taskRepo,
    schemaRepo,
    queues,
    tenantRepo,
  });

  // 18. Start webhook receiver
  const webhookReceiver = await startWebhookReceiver();

  // 19. Create the Hono API app via createApp(deps) — NOT createTestApp()
  process.env.AUTH_STRATEGY = 'none';

  const { createApp } = await import('@spatula/api');

  const appDeps = {
    dbPool: pool,
    jobRepo,
    schemaRepo,
    extractionRepo,
    entityRepo,
    entitySourceRepo,
    actionRepo,
    taskRepo,
    exportRepo,
    tenantRepo,
    dlqRepo,
    apiKeyRepo,
    auditLogRepo,
    llmUsageRepo,
    jobManager,
    exportQueue: queues.export,
    contentStore,
    auditLogger,
    redis,
    queues,
  };

  const app = createApp(appDeps as any);

  // 20. Create a test tenant
  const tenantRes = await app.request('/api/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tier 5A Test Tenant' }),
  });

  if (tenantRes.status !== 201) {
    const body = await tenantRes.text();
    throw new Error(`Failed to create test tenant: ${tenantRes.status} ${body}`);
  }

  const tenantBody = await tenantRes.json();
  const tenantId = tenantBody.data.id;

  // 21. Return harness with closeAll() cleanup
  return {
    workers,
    workerDeps,
    queues,
    jobManager,
    fixtureServer,
    mockOllama,
    webhookReceiver,
    app,
    tenantId,
    pool: pool as unknown as Pool,
    db,
    closeAll: async () => {
      // Close workers first (let in-flight jobs finish)
      await Promise.all(workers.map((w) => w.close().catch(() => {})));

      // Close queues
      await queues.closeAll().catch(() => {});

      // Close crawler
      await crawler.close().catch(() => {});

      // Close Redis
      await redis.quit().catch(() => {});

      // Close database pool
      await pool.end().catch(() => {});

      // Stop servers
      await fixtureServer.close().catch(() => {});
      await mockOllama.close().catch(() => {});
      await webhookReceiver.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// waitForJobStatus()
// ---------------------------------------------------------------------------

export async function waitForJobStatus(
  jobRepo: any,
  jobId: string,
  tenantId: string,
  targetStatuses: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await jobRepo.findById(jobId, tenantId);
    if (job && targetStatuses.includes(job.status)) return job.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Job ${jobId} did not reach ${targetStatuses.join('|')} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// waitForExportStatus()
// ---------------------------------------------------------------------------

export async function waitForExportStatus(
  exportRepo: any,
  exportId: string,
  tenantId: string,
  targetStatuses: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exp = await exportRepo.findById(exportId, tenantId);
    if (exp && targetStatuses.includes(exp.status)) return exp.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Export ${exportId} did not reach ${targetStatuses.join('|')} within ${timeoutMs}ms`);
}
