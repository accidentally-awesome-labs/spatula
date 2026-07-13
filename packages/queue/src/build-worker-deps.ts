// packages/queue/src/build-worker-deps.ts
// Composition helper that builds a full WorkerDeps from env config.
// Called by startWorker() (production) and injectable for tests via _opts.deps.

import { createLogger, getEnvOrDefault } from '@spatula/shared';
import {
  createLLMClient,
  CircuitBreakerLLMClient,
  PageClassifier,
  StaticExtractor,
  SchemaEvolverImpl,
  DataReconcilerImpl,
  LLMLinkEvaluator,
  RobotsTxtChecker,
  InMemoryDomainRateLimiter,
  CrawlCompletionChecker,
  CrawlerFactory,
  createContentStore,
  resolveModel,
} from '@spatula/core';
import type { LLMClient, LLMConfig } from '@spatula/core';
import {
  JobRepository,
  CrawlTaskRepository,
  PageRepository,
  ExtractionRepository,
  SchemaRepository,
  EntityRepository,
  EntitySourceRepository,
  SourceTrustRepository,
  ExportRepository,
  ActionRepository,
  TenantRepository,
  PgContentStore,
} from '@spatula/db';
import type { Pool } from 'pg';
import type { Database } from '@spatula/db';
import type { SpatulaQueues } from './queues.js';
import { WorkerDeps } from './worker-deps.js';
import type { EventPublisher } from './events.js';

const logger = createLogger('build-worker-deps');

export interface BuildWorkerDepsInput {
  db: Database | any; // the drizzle db from createDatabasePool()
  pool: Pool; // the pg Pool from createDatabasePool()
  queues: SpatulaQueues; // already created in startWorker
  eventPublisher?: EventPublisher;
}

export interface BuildWorkerDepsResult {
  deps: WorkerDeps;
  rawClient: LLMClient;
  llmClient: LLMClient;
  llmConfig: LLMConfig;
}

export async function buildWorkerDeps(input: BuildWorkerDepsInput): Promise<BuildWorkerDepsResult> {
  const { db, pool, queues, eventPublisher } = input;

  // Step 1 — FAIL-LOUD: OPENROUTER_API_KEY is required; the worker cannot
  // extract/classify/reconcile without it. Do this FIRST before any async ops.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'buildWorkerDeps: OPENROUTER_API_KEY is required — the worker cannot extract/classify/reconcile without it. Set OPENROUTER_API_KEY on the worker service.',
    );
  }

  // Step 2 — Repositories (each takes the drizzle db instance)
  const jobRepo = new JobRepository(db);
  const taskRepo = new CrawlTaskRepository(db);
  const pageRepo = new PageRepository(db);
  const extractionRepo = new ExtractionRepository(db);
  const schemaRepo = new SchemaRepository(db);
  const entityRepo = new EntityRepository(db);
  const entitySourceRepo = new EntitySourceRepository(db);
  const sourceTrustRepo = new SourceTrustRepository(db);
  const exportRepo = new ExportRepository(db);
  const actionRepo = new ActionRepository(db);
  const tenantRepo = new TenantRepository(db);

  // Step 3 — Content store (mirrors apps/api/src/main.ts buildAppDeps lines 85–96)
  const contentStoreType = getEnvOrDefault('CONTENT_STORE', 'postgres');
  const contentStore =
    contentStoreType === 's3'
      ? createContentStore({
          type: 's3',
          s3: {
            bucket: getEnvOrDefault('S3_BUCKET', ''),
            region: getEnvOrDefault('S3_REGION', 'us-east-1'),
            ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
          },
        })
      : new PgContentStore(db);

  // Step 4 — Base llmConfig (per-job override is derived at runtime; this is the worker default)
  const llmConfig: LLMConfig = {
    primaryModel: process.env.SPATULA_DEFAULT_MODEL ?? 'deepseek/deepseek-v4-flash',
  };

  // Step 5 — LLM client: create raw first so usage recording can wrap it,
  // then wrap with circuit breaker.
  const rawClient = createLLMClient({
    provider: 'openrouter',
    openrouter: {
      apiKey,
      baseUrl: process.env.OPENROUTER_BASE_URL,
    },
  });
  const llmClient = new CircuitBreakerLLMClient(rawClient);

  // Step 6 — LLM-dependent components
  const classifier = new PageClassifier(llmClient, llmConfig);
  const extractor = new StaticExtractor(llmClient, llmConfig, ''); // '' as base jobId; per-job override at runtime
  const schemaEvolver = new SchemaEvolverImpl(llmClient, llmConfig);
  const reconciler = new DataReconcilerImpl(llmClient, llmConfig);
  const linkEvaluator = new LLMLinkEvaluator(llmClient, resolveModel(llmConfig, 'linkEvaluation'));

  // Step 7 — Crawl infrastructure
  const robotsChecker = new RobotsTxtChecker();
  const rateLimiter = new InMemoryDomainRateLimiter();
  const completionChecker = new CrawlCompletionChecker();

  // Step 8 — Crawler
  // distroless Dockerfile.worker ships NO Playwright browser → the Render/distroless worker
  // MUST set SPATULA_CRAWLER=firecrawl (+ FIRECRAWL_API_KEY). Baking Playwright into the
  // worker image is a deferred follow-up (DEFER, 19.1-CONTEXT).
  const crawlerType = (process.env.SPATULA_CRAWLER ?? 'playwright') as 'playwright' | 'firecrawl';
  const crawler = await CrawlerFactory.create({
    type: crawlerType,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
  });

  // Step 9 — Construct and return WorkerDeps + raw/wrapped clients for Plans 02/03
  const deps = new WorkerDeps({
    dbPool: pool,
    crawler,
    extractor,
    classifier,
    contentStore,
    schemaEvolver,
    reconciler,
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
    eventPublisher,
    linkEvaluator,
    robotsChecker,
    rateLimiter,
    completionChecker,
    tenantRepo,
    queues,
  });

  logger.info(
    { crawlerType, contentStore: contentStoreType, defaultModel: llmConfig.primaryModel },
    'WorkerDeps built',
  );

  return { deps, rawClient, llmClient, llmConfig };
}
