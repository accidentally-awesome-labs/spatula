// packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalPipelineRunner } from '../../../src/pipeline/local-pipeline-runner.js';
import type { LocalPipelineConfig } from '../../../src/pipeline/local-pipeline-runner.js';
import type { CrawlOrchestratorDeps, CrawlTaskResult } from '../../../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock factory — builds the full LocalPipelineConfig with all repos mocked
// ---------------------------------------------------------------------------

function createMockConfig(overrides?: Partial<LocalPipelineConfig>): LocalPipelineConfig {
  const projectId = 'proj-1';

  const taskRepo = {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateClassification: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockImplementation(async (data: { url: string }) => ({
      id: `task-${data.url.split('/').pop()}`,
    })),
    findPending: vi.fn().mockResolvedValue([]),
    findByStatus: vi.fn().mockResolvedValue([]),
    getJobStats: vi.fn().mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    }),
  };

  const pageRepo = {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findByIds: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'page-1' }),
  };

  const jobRepo = {
    findById: vi.fn().mockResolvedValue({
      id: projectId,
      status: 'running',
      config: {
        tenantId: projectId,
        name: 'Test Project',
        description: 'Scrape products from example.com',
        seedUrls: ['https://example.com'],
        crawl: { maxDepth: 2, maxPages: 100, concurrency: 2, crawlerType: 'playwright' },
        schema: { mode: 'discovery', evolutionConfig: { enabled: false } },
        llm: { primaryModel: 'test-model' },
      },
    }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };

  const extractionRepo = {
    store: vi.fn().mockResolvedValue(undefined),
    findByJob: vi.fn().mockResolvedValue([]),
  };

  const schemaRepo = {
    findLatest: vi.fn().mockResolvedValue({
      id: 'schema-1',
      version: 1,
      definition: { version: 1, fields: { name: { type: 'string' } } },
    }),
    create: vi.fn().mockResolvedValue(undefined),
  };

  const entityRepo = {
    create: vi.fn().mockResolvedValue({ id: 'entity-1' }),
    findByJob: vi.fn().mockResolvedValue([]),
    findByJobWithProvenance: vi.fn().mockResolvedValue([]),
    countByJob: vi.fn().mockResolvedValue(0),
  };

  const entitySourceRepo = {
    bulkLink: vi.fn().mockResolvedValue(undefined),
  };

  const sourceTrustRepo = {
    upsert: vi.fn().mockResolvedValue(undefined),
  };

  const actionRepo = {
    create: vi.fn().mockResolvedValue(undefined),
  };

  const exportRepo = {
    create: vi.fn().mockResolvedValue({ id: 'export-1' }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };

  const runRepo = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateStats: vi.fn().mockResolvedValue(undefined),
    findLatestByStatus: vi.fn().mockResolvedValue(null),
  };

  const metaRepo = {
    getAll: vi.fn().mockResolvedValue({}),
  };

  const adapter = {
    getProjectId: () => projectId,
    jobRepo,
    taskRepo,
    pageRepo,
    extractionRepo,
    schemaRepo,
    entityRepo,
    entitySourceRepo,
    sourceTrustRepo,
    actionRepo,
    exportRepo,
    runRepo,
    metaRepo,
  };

  const crawler = {
    type: 'playwright' as const,
    crawl: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      html: '<html><body>Hello</body></html>',
      title: 'Example',
      statusCode: 200,
      contentType: 'text/html',
      links: [],
      metadata: {
        crawledAt: new Date(),
        responseTimeMs: 100,
        contentLength: 30,
        crawlerType: 'playwright' as const,
      },
    }),
    close: vi.fn(),
  };

  const extractor = {
    extract: vi.fn().mockResolvedValue({
      data: { name: 'Test Product' },
      metadata: {
        confidence: 0.9,
        modelUsed: 'test-model',
        tokensUsed: 100,
        extractionTimeMs: 200,
        unmappedFields: [],
      },
    }),
  };

  const classifier = {
    classify: vi.fn().mockResolvedValue({
      classification: 'single_entry',
      confidence: 0.95,
    }),
  };

  const contentStore = {
    store: vi.fn().mockResolvedValue('ref-123'),
    retrieve: vi.fn().mockResolvedValue(''),
    delete: vi.fn().mockResolvedValue(undefined),
    storeBinary: vi.fn().mockResolvedValue('ref-bin-123'),
    retrieveBinary: vi.fn().mockResolvedValue(null),
  };

  return {
    adapter,
    config: {
      tenantId: projectId,
      name: 'Test Project',
      description: 'Scrape products from example.com',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 100, concurrency: 2, crawlerType: 'playwright' },
      schema: { mode: 'discovery', evolutionConfig: { enabled: false } },
      llm: { primaryModel: 'test-model' },
    },
    projectDir: '/tmp/test-project',
    crawler,
    extractor,
    classifier,
    contentStore,
    lock: {
      acquire: vi.fn().mockReturnValue(true),
      release: vi.fn(),
      isAcquired: true,
    },
    retryBaseMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub processCrawlTask at the module level
// ---------------------------------------------------------------------------

// We mock the orchestrator modules to avoid pulling in real dependencies
vi.mock('../../../src/pipeline/crawl-orchestrator.js', () => ({
  processCrawlTask: vi.fn(),
  shouldTriggerSchemaEvolution: vi
    .fn()
    .mockResolvedValue({ trigger: false, extractionIds: [], schemaVersion: 1 }),
  isValidCrawlUrl: (url: string) => url.startsWith('http'),
}));

vi.mock('../../../src/pipeline/schema-orchestrator.js', () => ({
  processSchemaEvolution: vi.fn().mockResolvedValue({ evolved: false, actionsApplied: 0 }),
}));

vi.mock('../../../src/pipeline/reconcile-orchestrator.js', () => ({
  processReconciliation: vi.fn().mockResolvedValue({ entitiesCreated: 5, actionsGenerated: 2 }),
}));

vi.mock('../../../src/pipeline/export-orchestrator.js', () => ({
  processExport: vi
    .fn()
    .mockResolvedValue({ entityCount: 5, fileSize: 1024, contentRef: 'export-ref' }),
}));

vi.mock('../../../src/config/config-differ.js', () => ({
  diffConfigs: vi.fn().mockReturnValue({ hasChanges: false }),
}));

// No-op lock provided via config.lock (avoids file system side effects)

import { processCrawlTask } from '../../../src/pipeline/crawl-orchestrator.js';
import { processSchemaEvolution } from '../../../src/pipeline/schema-orchestrator.js';
import { processReconciliation } from '../../../src/pipeline/reconcile-orchestrator.js';
import { processExport } from '../../../src/pipeline/export-orchestrator.js';
import { diffConfigs } from '../../../src/config/config-differ.js';

const mockProcessCrawlTask = processCrawlTask as ReturnType<typeof vi.fn>;
const mockProcessSchemaEvolution = processSchemaEvolution as ReturnType<typeof vi.fn>;
const mockProcessReconciliation = processReconciliation as ReturnType<typeof vi.fn>;
const mockProcessExport = processExport as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalPipelineRunner', () => {
  let cfg: LocalPipelineConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    cfg = createMockConfig();

    // Default crawl result — no links, successful
    mockProcessCrawlTask.mockResolvedValue({
      pageId: 'page-1',
      classification: 'single_entry',
      extracted: true,
      linksFound: [],
      contentHash: 'abc123',
      deduplicated: false,
      schemaVersion: 1,
      evolutionConfig: null,
    } satisfies CrawlTaskResult);

    // Re-set mocks cleared by vi.clearAllMocks()
    mockProcessSchemaEvolution.mockResolvedValue({ evolved: false, actionsApplied: 0 });
    mockProcessReconciliation.mockResolvedValue({ entitiesCreated: 5, actionsGenerated: 2 });
    mockProcessExport.mockResolvedValue({
      entityCount: 5,
      fileSize: 1024,
      contentRef: 'export-ref',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Creates runner instance
  it('creates a runner instance', () => {
    const runner = new LocalPipelineRunner(cfg);
    expect(runner).toBeDefined();
    expect(runner).toBeInstanceOf(LocalPipelineRunner);
  });

  // 2. Creates run record on start
  it('creates a run record on start', async () => {
    // Set up seed URL task so the runner has something to do
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    const runRepo = cfg.adapter.runRepo as any;
    expect(runRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        source: 'local',
      }),
    );
  });

  // 3. Enqueues seed URLs on first run (no pending tasks)
  it('enqueues seed URLs when no pending tasks exist', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    // After seeding, findPending returns the seed task, then empty
    let findPendingCallCount = 0;
    taskRepo.findPending.mockImplementation(async () => {
      findPendingCallCount++;
      if (findPendingCallCount === 1) {
        return [
          {
            id: 'task-seed',
            url: 'https://example.com',
            depth: 0,
            priorityScore: 100,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com',
        depth: 0,
      }),
    );
  });

  // 4. Recovers crashed tasks (resets in_progress to pending)
  it('recovers crashed tasks by resetting in_progress to pending', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;

    // Has in-progress tasks from a previous crashed run
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 2,
      completed: 5,
      failed: 0,
      skipped: 0,
    });

    // findByStatus returns the in_progress tasks for recovery
    taskRepo.findByStatus.mockResolvedValue([{ id: 'task-crashed-1' }, { id: 'task-crashed-2' }]);

    // After recovery, no more pending tasks to process
    taskRepo.findPending.mockResolvedValue([]);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Should have called updateStatus to reset each in_progress task to pending
    expect(taskRepo.updateStatus).toHaveBeenCalledWith('task-crashed-1', 'proj-1', 'pending');
    expect(taskRepo.updateStatus).toHaveBeenCalledWith('task-crashed-2', 'proj-1', 'pending');
  });

  // 5. Skips task when page budget exhausted
  it('skips task when page budget is exhausted', async () => {
    // Set maxPages to 0 so budget is immediately exhausted
    cfg.config = {
      ...cfg.config,
      crawl: { ...cfg.config.crawl, maxPages: 0 },
    };

    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 1,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });
    taskRepo.findPending
      .mockResolvedValueOnce([
        {
          id: 'task-1',
          url: 'https://example.com',
          depth: 0,
          priorityScore: 100,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        },
      ])
      .mockResolvedValue([]);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // processCrawlTask should NOT have been called
    expect(mockProcessCrawlTask).not.toHaveBeenCalled();
  });

  // 6. Retries failed tasks up to 3 times
  it('retries failed tasks up to 3 times', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    // Seed task
    let findPendingCallCount = 0;
    taskRepo.findPending.mockImplementation(async () => {
      findPendingCallCount++;
      if (findPendingCallCount === 1) {
        return [
          {
            id: 'task-retry',
            url: 'https://example.com',
            depth: 0,
            priorityScore: 100,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    // processCrawlTask fails first 2 times, succeeds on 3rd
    let crawlCallCount = 0;
    mockProcessCrawlTask.mockImplementation(async () => {
      crawlCallCount++;
      if (crawlCallCount < 3) {
        return {
          pageId: '',
          classification: 'unknown',
          extracted: false,
          linksFound: [],
          contentHash: '',
          deduplicated: false,
          schemaVersion: null,
          evolutionConfig: null,
          error: new Error('network timeout'),
        } satisfies CrawlTaskResult;
      }
      return {
        pageId: 'page-ok',
        classification: 'single_entry',
        extracted: true,
        linksFound: [],
        contentHash: 'abc',
        deduplicated: false,
        schemaVersion: 1,
        evolutionConfig: null,
      } satisfies CrawlTaskResult;
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Should have been called 3 times (2 retries + 1 success)
    expect(mockProcessCrawlTask).toHaveBeenCalledTimes(3);
  });

  // 7. Marks task as failed after max retries
  it('marks task as permanently failed after max retries', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    let findPendingCallCount = 0;
    taskRepo.findPending.mockImplementation(async () => {
      findPendingCallCount++;
      if (findPendingCallCount === 1) {
        return [
          {
            id: 'task-doomed',
            url: 'https://example.com',
            depth: 0,
            priorityScore: 100,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    // Always fail
    mockProcessCrawlTask.mockResolvedValue({
      pageId: '',
      classification: 'unknown',
      extracted: false,
      linksFound: [],
      contentHash: '',
      deduplicated: false,
      schemaVersion: null,
      evolutionConfig: null,
      error: new Error('permanent failure'),
    } satisfies CrawlTaskResult);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Called maxRetries (3) times
    expect(mockProcessCrawlTask).toHaveBeenCalledTimes(3);

    // Task should be marked as failed
    expect(taskRepo.updateStatus).toHaveBeenCalledWith('task-doomed', expect.any(String), 'failed');
  });

  // 8. Calls reconciliation after crawl loop (if reconciler provided)
  it('calls reconciliation when reconciler is provided', async () => {
    cfg.reconciler = {
      reconcile: vi.fn().mockResolvedValue({
        entities: [],
        actions: [],
      }),
    };

    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 1,
      failed: 0,
      skipped: 0,
    });
    // Already completed crawl in a previous run — no pending tasks
    taskRepo.findPending.mockResolvedValue([]);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    expect(mockProcessReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'proj-1',
        tenantId: 'proj-1',
      }),
      expect.objectContaining({
        reconciler: cfg.reconciler,
      }),
    );
  });

  // 9. Calls export when autoExport is true
  it('calls export when autoExport is enabled', async () => {
    cfg.config = {
      ...cfg.config,
      export: { autoExport: true, format: 'json', includeProvenance: false },
    };

    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 1,
      failed: 0,
      skipped: 0,
    });
    taskRepo.findPending.mockResolvedValue([]);

    // Job must be completed for export
    (cfg.adapter.jobRepo as any).findById.mockResolvedValue({
      id: 'proj-1',
      status: 'completed',
      config: cfg.config,
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    expect(mockProcessExport).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'proj-1',
        format: 'json',
      }),
      expect.any(Object),
    );
  });

  // 10. Stops gracefully and releases lock
  it('stops gracefully and releases lock', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    // Provide tasks that keep coming so we can test stop
    let findPendingCallCount = 0;
    taskRepo.findPending.mockImplementation(async () => {
      findPendingCallCount++;
      if (findPendingCallCount <= 5) {
        return [
          {
            id: `task-${findPendingCallCount}`,
            url: `https://example.com/p${findPendingCallCount}`,
            depth: 0,
            priorityScore: 100,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    // Make crawl take a bit of time and stop after 2nd task
    mockProcessCrawlTask.mockImplementation(async () => {
      if (findPendingCallCount >= 2) {
        // Trigger stop from another context
        runner.stop();
      }
      return {
        pageId: 'page-1',
        classification: 'single_entry',
        extracted: true,
        linksFound: [],
        contentHash: 'abc',
        deduplicated: false,
        schemaVersion: 1,
        evolutionConfig: null,
      } satisfies CrawlTaskResult;
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Run record should be updated to paused
    const runRepo = cfg.adapter.runRepo as any;
    expect(runRepo.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      'paused',
      expect.any(String),
    );
  });

  // 11. Enqueues discovered links from crawl results
  it('enqueues discovered links from crawl results', async () => {
    const taskRepo = cfg.adapter.taskRepo as any;
    taskRepo.getJobStats.mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });

    let findPendingCallCount = 0;
    taskRepo.findPending.mockImplementation(async () => {
      findPendingCallCount++;
      if (findPendingCallCount === 1) {
        return [
          {
            id: 'task-seed',
            url: 'https://example.com',
            depth: 0,
            priorityScore: 100,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    // Crawl returns discovered links
    mockProcessCrawlTask.mockResolvedValueOnce({
      pageId: 'page-1',
      classification: 'navigation',
      extracted: false,
      linksFound: [
        { url: 'https://example.com/product/1', text: 'Product 1', relevanceScore: 0.9 },
        { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.8 },
      ],
      contentHash: 'hash1',
      deduplicated: false,
      schemaVersion: 1,
      evolutionConfig: null,
    } satisfies CrawlTaskResult);

    // Second round — process the enqueued links
    mockProcessCrawlTask.mockResolvedValue({
      pageId: 'page-2',
      classification: 'single_entry',
      extracted: true,
      linksFound: [],
      contentHash: 'hash2',
      deduplicated: false,
      schemaVersion: 1,
      evolutionConfig: null,
    } satisfies CrawlTaskResult);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Should have enqueued the 2 discovered links (+ 1 seed = 3 total enqueue calls)
    expect(taskRepo.enqueue).toHaveBeenCalledTimes(3);
    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/product/1',
        depth: 1,
      }),
    );
    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/product/2',
        depth: 1,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Config diff
  // -------------------------------------------------------------------------

  it('enqueues new seeds from config diff on subsequent runs', async () => {
    const { adapter } = cfg;
    const { taskRepo, runRepo } = adapter;
    const mockDiffConfigs = diffConfigs as ReturnType<typeof vi.fn>;

    // Simulate existing tasks (not first run)
    (taskRepo.getJobStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 5,
      failed: 0,
      skipped: 0,
    });

    // Previous run exists with a config snapshot
    (runRepo.findLatestByStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'prev-run',
      configSnapshot: { seedUrls: ['https://example.com'] },
    });

    // Config diff says new seed was added
    mockDiffConfigs.mockReturnValue({
      hasChanges: true,
      seedsAdded: ['https://example.com/new-page'],
      seedsRemoved: [],
      fieldsAdded: [],
      fieldsRemoved: [],
      fieldsModified: [],
      potentialRenames: [],
      crawlChanged: { proxyChanged: false, cookiesChanged: false },
      llmChanged: false,
      reconciliationChanged: false,
      safetyChanged: false,
      impact: {
        newTasksToEnqueue: 1,
        pagesNeedingReextraction: null,
        reextractionCostEstimate: 0,
        failedTasksToRetry: null,
        skippedTasksToReenqueue: null,
        forceFullReconciliation: false,
      },
    });

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Should enqueue only the new seed, not all seeds
    expect(taskRepo.enqueue).toHaveBeenCalledTimes(1);
    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/new-page', depth: 0 }),
    );
  });

  it('flags pages for re-extraction when schema fields change', async () => {
    const { adapter } = cfg;
    const { taskRepo, runRepo, pageRepo } = adapter;
    const mockDiffConfigs = diffConfigs as ReturnType<typeof vi.fn>;

    // Not first run
    (taskRepo.getJobStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      pending: 0,
      inProgress: 0,
      completed: 3,
      failed: 0,
      skipped: 0,
    });

    // Previous run
    (runRepo.findLatestByStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'prev-run',
      configSnapshot: {
        seedUrls: ['https://example.com'],
        schema: { mode: 'fixed', userFields: [{ name: 'title' }] },
      },
    });

    // Config diff: field added
    mockDiffConfigs.mockReturnValue({
      hasChanges: true,
      seedsAdded: [],
      seedsRemoved: [],
      fieldsAdded: [{ name: 'price', type: 'number' }],
      fieldsRemoved: [],
      fieldsModified: [],
      potentialRenames: [],
      crawlChanged: { proxyChanged: false, cookiesChanged: false },
      llmChanged: false,
      reconciliationChanged: false,
      safetyChanged: false,
      impact: {
        newTasksToEnqueue: 0,
        pagesNeedingReextraction: null,
        reextractionCostEstimate: 0.5,
        failedTasksToRetry: null,
        skippedTasksToReenqueue: null,
        forceFullReconciliation: false,
      },
    });

    // Add flagForReextraction to the mock page repo
    (pageRepo as any).flagForReextraction = vi.fn().mockResolvedValue(3);
    (pageRepo as any).findNeedingReextraction = vi
      .fn()
      .mockResolvedValue([
        { id: 'page-1', url: 'https://example.com', contentRef: 'file:///pages/abc.html' },
      ]);
    (pageRepo as any).clearReextractionFlag = vi.fn().mockResolvedValue(undefined);

    // Mock content store retrieve for re-extraction
    (cfg.contentStore as any).retrieve = vi
      .fn()
      .mockResolvedValue('<html><body>Cached HTML</body></html>');

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // Should flag pages
    expect((pageRepo as any).flagForReextraction).toHaveBeenCalledWith(
      'proj-1',
      expect.stringContaining('1 fields added'),
    );

    // Should re-extract flagged pages
    expect(cfg.extractor.extract).toHaveBeenCalledWith(
      '<html><body>Cached HTML</body></html>',
      'https://example.com',
      expect.anything(),
      expect.any(String),
    );

    // Should clear flags after processing
    expect((pageRepo as any).clearReextractionFlag).toHaveBeenCalledWith(['page-1']);

    // Should update run stats with reextracted count
    expect(adapter.runRepo.updateStats).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ pagesReextracted: 1 }),
    );
  });

  it('skips config diff when no previous run exists', async () => {
    const { adapter } = cfg;
    const mockDiffConfigs = diffConfigs as ReturnType<typeof vi.fn>;

    // No previous run
    (adapter.runRepo.findLatestByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const runner = new LocalPipelineRunner(cfg);
    await runner.run();

    // diffConfigs should never be called
    expect(mockDiffConfigs).not.toHaveBeenCalled();
  });
});
