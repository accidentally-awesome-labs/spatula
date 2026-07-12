// packages/queue/src/worker-entrypoint.test.ts
//
// Integration unit tests proving the three gap-closure invariants (Plans 01-03):
//   1. startWorker({ deps: stubDeps }) honors the injected deps (Gap 1: no buildWorkerDeps call)
//   2. AlsUsageRecorder inside usageContext.run() attributes usage to the active tenant/job (Gap 3)
//   3. deriveJobDeps yields distinct component instances per distinct LLMConfig (Gap 2)
//
// No real I/O: all heavy dependencies are mocked.

import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── Mock heavy dependencies (same strategy as tests/unit/worker-entrypoint.test.ts) ───

vi.mock('bullmq', () => {
  class Worker {
    on() {}
    async close() {}
  }
  class Queue {
    async add() {}
    async close() {}
  }
  return { Worker, Queue };
});

vi.mock('ioredis', () => {
  const Redis = vi.fn().mockImplementation(() => ({
    quit: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
  }));
  return { default: Redis };
});

vi.mock('@spatula/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  loadConfig: () => ({
    redis: { url: 'redis://localhost:6379' },
  }),
  getEnvOrDefault: vi.fn((key: string, def: string) => def),
}));

vi.mock('@spatula/db', () => ({
  createDatabasePool: vi.fn().mockReturnValue({
    db: {},
    pool: { end: vi.fn().mockResolvedValue(undefined) },
  }),
  DlqRepository: vi.fn().mockImplementation(() => ({})),
  TenantDataRepository: vi.fn().mockImplementation(() => ({})),
  LlmUsageRepository: vi.fn().mockImplementation(() => ({
    insert: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./dlq-handler.js', () => ({
  createDlqHandler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('./queues.js', () => ({
  QUEUE_NAMES: {
    CRAWL: 'spatula.crawl',
    SCHEMA_EVOLUTION: 'spatula.schema-evolution',
    RECONCILIATION: 'spatula.reconciliation',
    EXPORT: 'spatula.export',
    WEBHOOK: 'spatula.webhook',
    CLEANUP: 'spatula.cleanup',
    TENANT_DELETE: 'spatula.tenant-delete',
  },
  DEFAULT_QUEUE_CONFIG: {
    crawl: { concurrency: 2, rateLimitMax: 10, rateLimitDuration: 1000 },
    schemaEvolution: { concurrency: 1 },
    reconciliation: { concurrency: 1 },
    export: { concurrency: 1 },
  },
  createQueues: vi.fn().mockReturnValue({
    crawl: {},
    schemaEvolution: {},
    reconciliation: {},
    export: {},
    webhook: {},
    cleanup: {},
    tenantDelete: {},
    closeAll: vi.fn().mockResolvedValue(undefined),
  }),
  redisConnectionOptionsFromUrl: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
}));

vi.mock('./worker-selection.js', () => ({
  parseEnabledWorkers: vi.fn().mockReturnValue('all'),
  isWorkerEnabled: vi.fn().mockReturnValue(false), // disable all workers — no real connections
}));

vi.mock('./worker-heartbeat.js', () => ({
  WorkerHeartbeat: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('./webhook-worker.js', () => ({
  createWebhookWorker: vi.fn().mockReturnValue({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('./cleanup-worker.js', () => ({
  processCleanupJob: vi.fn(),
}));

vi.mock('./workers/crawl-worker.js', () => ({
  processCrawlJob: vi.fn(),
}));

vi.mock('./workers/schema-worker.js', () => ({
  processSchemaEvolutionJob: vi.fn(),
}));

vi.mock('./workers/reconciliation-worker.js', () => ({
  processReconciliationJob: vi.fn(),
}));

vi.mock('./workers/export-worker.js', () => ({
  processExportJob: vi.fn(),
}));

vi.mock('./workers/tenant-delete-worker.js', () => ({
  processTenantDeleteJob: vi.fn(),
}));

// Build-worker-deps: mock so startWorker without _opts.deps doesn't need real env
vi.mock('./build-worker-deps.js', () => ({
  buildWorkerDeps: vi.fn().mockResolvedValue({
    deps: {
      crawler: { close: vi.fn().mockResolvedValue(undefined) },
      contentStore: {},
    },
    rawClient: {},
    llmClient: {},
    llmConfig: { primaryModel: 'deepseek/deepseek-v4-pro' },
  }),
}));

// ─── Test 1: startWorker({ deps }) injection seam (Gap-1) ────────────────────

describe('startWorker({ deps: stubDeps }) — Gap-1 injection seam', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('honors injected deps — no buildWorkerDeps call, returns handle with shutdown()', async () => {
    const { buildWorkerDeps } = await import('./build-worker-deps.js');
    const { startWorker } = await import('./worker-entrypoint.js');

    const stubDeps = {
      crawler: { close: vi.fn().mockResolvedValue(undefined) },
      contentStore: {},
      jobRepo: {},
      taskRepo: {},
      pageRepo: {},
      extractionRepo: {},
      schemaRepo: {},
      entityRepo: {},
      sourceTrustRepo: {},
      entitySourceRepo: {},
      exportRepo: {},
      actionRepo: {},
      tenantRepo: {},
      queues: { closeAll: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const handle = await startWorker({ deps: stubDeps });

    // buildWorkerDeps must NOT have been called — deps were injected
    expect(buildWorkerDeps).not.toHaveBeenCalled();

    // Handle must be non-null and have a working shutdown()
    expect(handle).toBeDefined();
    expect(typeof handle.shutdown).toBe('function');

    const shutdownResult = handle.shutdown();
    expect(shutdownResult).toBeInstanceOf(Promise);
    await shutdownResult;
  });

  it('wires a Redis event publisher into production WorkerDeps', async () => {
    const { buildWorkerDeps } = await import('./build-worker-deps.js');
    const { startWorker } = await import('./worker-entrypoint.js');

    const handle = await startWorker();

    expect(buildWorkerDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        eventPublisher: expect.objectContaining({ publish: expect.any(Function) }),
      }),
    );

    await handle.shutdown();
  });
});

// ─── Test 2: ALS attribution (Gap-3) ─────────────────────────────────────────

describe('AlsUsageRecorder + usageContext.run — Gap-3 ALS attribution', () => {
  it('record() inside usageContext.run({ tenantId, jobId }) inserts with correct attribution', async () => {
    const { AlsUsageRecorder } = await import('./als-usage-recorder.js');
    const { usageContext } = await import('./usage-context.js');

    const mockInsert = vi.fn().mockResolvedValue(undefined);
    const mockRepo = { insert: mockInsert } as any;
    const recorder = new AlsUsageRecorder(mockRepo);

    await usageContext.run({ tenantId: 'T-test', jobId: 'J-test' }, async () => {
      recorder.record({
        model: 'test-model',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costUsd: 0.001234,
        durationMs: 500,
        purpose: 'extraction',
      });
      // Let fire-and-forget settle
      await Promise.resolve();
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'T-test',
        jobId: 'J-test',
        model: 'test-model',
      }),
    );
  });
});

// ─── Test 3: Per-job model derivation (Gap-2) ────────────────────────────────

// Mock @spatula/core for the per-job tests (same pattern as derive-job-deps.test.ts)
vi.mock('@spatula/core', () => {
  const resolveModel = (
    config: { primaryModel: string; modelOverrides?: Record<string, string> },
    task: string,
  ): string => config.modelOverrides?.[task] ?? config.primaryModel;

  class PageClassifier {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class StaticExtractor {
    constructor(
      public llmClient: unknown,
      public config: unknown,
      public jobId: string,
    ) {}
  }
  class SchemaEvolverImpl {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class DataReconcilerImpl {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class LLMLinkEvaluator {
    constructor(
      public llmClient: unknown,
      public model: string,
    ) {}
  }

  return {
    resolveModel,
    PageClassifier,
    StaticExtractor,
    SchemaEvolverImpl,
    DataReconcilerImpl,
    LLMLinkEvaluator,
  };
});

vi.mock('./worker-deps.js', () => {
  class WorkerDeps {
    [key: string]: unknown;
    constructor(config: Record<string, unknown>) {
      Object.assign(this, config);
    }
  }
  return { WorkerDeps };
});

describe('deriveJobDeps — Gap-2 per-job model derivation', () => {
  it('two distinct LLMConfigs produce component instances that are NOT the same object', async () => {
    const { deriveJobDeps } = await import('./derive-job-deps.js');

    const stubBase = {
      dbPool: {},
      crawler: {},
      contentStore: {},
      jobRepo: {},
      taskRepo: {},
      pageRepo: {},
      extractionRepo: {},
      schemaRepo: {},
      entityRepo: {},
      sourceTrustRepo: {},
      entitySourceRepo: {},
      exportRepo: {},
      actionRepo: {},
      queues: {},
      eventPublisher: {},
      robotsChecker: {},
      rateLimiter: {},
      pageBudget: {},
      completionChecker: {},
      tenantRepo: {},
      classifier: { _stub: 'base-classifier' },
      extractor: { _stub: 'base-extractor' },
      schemaEvolver: { _stub: 'base-schemaEvolver' },
      reconciler: { _stub: 'base-reconciler' },
      linkEvaluator: { _stub: 'base-linkEvaluator' },
    } as any;

    const stubClient = { complete: vi.fn() } as any;

    const depsA = deriveJobDeps(stubBase, stubClient, { primaryModel: 'tier-fast' }, 'job-A');
    const depsB = deriveJobDeps(stubBase, stubClient, { primaryModel: 'tier-smart' }, 'job-B');

    // The two sets of derived components must be different instances
    expect(depsA.extractor).not.toBe(depsB.extractor);
    expect(depsA.classifier).not.toBe(depsB.classifier);
    expect(depsA.schemaEvolver).not.toBe(depsB.schemaEvolver);
    expect(depsA.reconciler).not.toBe(depsB.reconciler);
    expect(depsA.linkEvaluator).not.toBe(depsB.linkEvaluator);
  });

  it('linkEvaluator model matches the primaryModel of the jobLlmConfig', async () => {
    const { deriveJobDeps } = await import('./derive-job-deps.js');

    const stubBase = {
      dbPool: {},
      crawler: {},
      contentStore: {},
      jobRepo: {},
      taskRepo: {},
      pageRepo: {},
      extractionRepo: {},
      schemaRepo: {},
      entityRepo: {},
      sourceTrustRepo: {},
      entitySourceRepo: {},
      exportRepo: {},
      actionRepo: {},
      queues: {},
      eventPublisher: {},
      robotsChecker: {},
      rateLimiter: {},
      pageBudget: {},
      completionChecker: {},
      tenantRepo: {},
      classifier: {},
      extractor: {},
      schemaEvolver: {},
      reconciler: {},
      linkEvaluator: {},
    } as any;

    const stubClient = { complete: vi.fn() } as any;

    const depsFast = deriveJobDeps(stubBase, stubClient, { primaryModel: 'tier-fast' }, 'job-fast');
    const depsSmart = deriveJobDeps(
      stubBase,
      stubClient,
      { primaryModel: 'tier-smart' },
      'job-smart',
    );

    // linkEvaluator.model must reflect the config it was built with
    expect((depsFast.linkEvaluator as any).model).toBe('tier-fast');
    expect((depsSmart.linkEvaluator as any).model).toBe('tier-smart');
  });
});
