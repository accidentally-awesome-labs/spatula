import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCrawlJob } from '../../../src/workers/crawl-worker.js';
import type { CrawlJobData } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';
import type { Pool } from 'pg';

function createMockCrawlResult() {
  return {
    url: 'https://example.com/product/1',
    html: '<html><body><h1>Product 1</h1></body></html>',
    title: 'Product 1',
    statusCode: 200,
    contentType: 'text/html',
    links: [
      { url: 'https://example.com/product/2', text: 'Product 2' },
      { url: 'https://example.com/product/3', text: 'Product 3' },
    ],
    metadata: {
      crawledAt: new Date(),
      responseTimeMs: 250,
      contentLength: 45,
      crawlerType: 'playwright' as const,
    },
  };
}

function createMockDeps(): WorkerDeps {
  const mockPage = {
    id: 'page-1',
    taskId: 'task-1',
    tenantId: 'tenant-1',
    contentRef: 'ref-abc',
    contentHash: 'hash-abc',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockJob = {
    id: 'job-1',
    tenantId: 'tenant-1',
    name: 'Test Job',
    description: 'Scrape product data',
    status: 'running' as const,
    config: {
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      seedUrls: ['https://example.com'],
      crawl: {
        maxDepth: 3,
        maxPages: 100,
        concurrency: 5,
        crawlerType: 'playwright' as const,
      },
      schema: {
        mode: 'discovery' as const,
      },
      llm: {
        primaryModel: 'anthropic/claude-sonnet-4-20250514',
      },
    },
    stats: {},
    schemaId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSchema = {
    id: 'schema-1',
    jobId: 'job-1',
    tenantId: 'tenant-1',
    version: 1,
    definition: {
      version: 1,
      fields: [
        {
          name: 'title',
          description: 'Product title',
          type: 'string' as const,
          required: true,
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    },
    parentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockExtraction = {
    id: 'extraction-1',
    jobId: 'job-1',
    pageId: 'page-1',
    schemaVersion: 1,
    data: { title: 'Product 1' },
    metadata: {
      confidence: 0.95,
      modelUsed: 'anthropic/claude-sonnet-4-20250514',
      tokensUsed: 500,
      extractionTimeMs: 200,
      unmappedFields: [],
    },
  };

  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    crawler: {
      type: 'playwright' as const,
      crawl: vi.fn().mockResolvedValue(createMockCrawlResult()),
      close: vi.fn().mockResolvedValue(undefined),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({
        classification: 'single_entry',
        confidence: 0.95,
        strategy: 'full_extraction',
        reasoning: 'Product page',
      }),
    } as any,
    extractor: {
      extract: vi.fn().mockResolvedValue(mockExtraction),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('content-ref-123'),
      retrieve: vi.fn().mockResolvedValue(''),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    schemaEvolver: {
      evolve: vi.fn().mockResolvedValue([]),
    },
    reconciler: {
      reconcile: vi.fn().mockResolvedValue({ entities: [], actions: [] }),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue(mockJob),
    } as any,
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue(null),
      updateClassification: vi.fn().mockResolvedValue(null),
      enqueue: vi
        .fn()
        .mockImplementation((input) =>
          Promise.resolve({ id: `child-task-${input.url}`, ...input }),
        ),
    } as any,
    pageRepo: {
      findByContentHash: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(mockPage),
      findByIds: vi.fn().mockResolvedValue([]),
    } as any,
    extractionRepo: {
      store: vi.fn().mockResolvedValue({ id: 'extraction-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findByPage: vi.fn().mockResolvedValue([]),
    } as any,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(mockSchema),
    } as any,
    entityRepo: {
      create: vi.fn().mockResolvedValue({ id: 'entity-1' }),
    } as any,
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'trust-1' }),
    } as any,
    entitySourceRepo: {
      bulkLink: vi.fn().mockResolvedValue([]),
    } as any,
    exportRepo: {
      create: vi.fn().mockResolvedValue({ id: 'export-1' }),
      findById: vi.fn().mockResolvedValue(null),
      findByJob: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(null),
    } as any,
    actionRepo: {
      create: vi.fn().mockResolvedValue({ id: 'action-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue(null),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    } as any,
    queues: {
      crawl: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      extract: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      schemaEvolution: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      reconciliation: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      closeAll: vi.fn().mockResolvedValue(undefined),
    } as any,
  } as unknown as WorkerDeps;
}

function createJobData(overrides?: Partial<CrawlJobData>): CrawlJobData {
  return {
    taskId: 'task-1',
    jobId: 'job-1',
    tenantId: 'tenant-1',
    url: 'https://example.com/product/1',
    depth: 0,
    ...overrides,
  };
}

describe('processCrawlJob', () => {
  let deps: WorkerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('crawls URL and stores content', async () => {
    const data = createJobData();

    await processCrawlJob(data, deps);

    expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    expect(deps.contentStore.store).toHaveBeenCalledWith(
      expect.stringContaining('job-1/'),
      '<html><body><h1>Product 1</h1></body></html>',
    );
    expect(deps.pageRepo.findByContentHash).toHaveBeenCalledWith(expect.any(String), 'tenant-1');
    expect(deps.pageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        tenantId: 'tenant-1',
        contentRef: 'content-ref-123',
        contentHash: expect.any(String),
      }),
    );
  });

  it('classifies the page', async () => {
    const data = createJobData();

    await processCrawlJob(data, deps);

    expect(deps.classifier.classify).toHaveBeenCalledWith(
      '<html><body><h1>Product 1</h1></body></html>',
      'https://example.com/product/1',
      'Scrape product data',
    );
    expect(deps.taskRepo.updateClassification).toHaveBeenCalledWith(
      'task-1',
      'tenant-1',
      'single_entry',
    );
  });

  it('extracts data for relevant pages (single_entry classification)', async () => {
    const data = createJobData();

    await processCrawlJob(data, deps);

    expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith('job-1', 'tenant-1');
    expect(deps.extractor.extract).toHaveBeenCalledWith(
      '<html><body><h1>Product 1</h1></body></html>',
      'https://example.com/product/1',
      expect.objectContaining({ version: 1 }),
      'Scrape product data',
    );
    expect(deps.extractionRepo.store).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        pageId: 'page-1',
        schemaVersion: 1,
      }),
    );
  });

  it('skips extraction for irrelevant pages', async () => {
    (deps.classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      classification: 'irrelevant',
      confidence: 0.9,
      strategy: 'skip',
      reasoning: 'Not a product page',
    });
    const data = createJobData();

    await processCrawlJob(data, deps);

    expect(deps.taskRepo.updateClassification).toHaveBeenCalledWith(
      'task-1',
      'tenant-1',
      'irrelevant',
    );
    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(deps.extractionRepo.store).not.toHaveBeenCalled();
  });

  it('enqueues discovered links within depth limit', async () => {
    const data = createJobData({ depth: 1 });

    await processCrawlJob(data, deps);

    // maxDepth is 3, current depth is 1, so links should be enqueued at depth 2
    // Verify child tasks are created in DB first
    expect(deps.taskRepo.enqueue).toHaveBeenCalledTimes(2);
    expect(deps.taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product/2',
        depth: 2,
        parentTaskId: 'task-1',
      }),
    );

    // Verify queue jobs reference real task IDs
    expect(deps.queues.crawl.add).toHaveBeenCalledTimes(2);
    expect(deps.queues.crawl.add).toHaveBeenCalledWith(
      'crawl:https://example.com/product/2',
      expect.objectContaining({
        taskId: expect.stringMatching(/.+/),
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product/2',
        depth: 2,
      }),
    );
  });

  it('does NOT enqueue links at max depth', async () => {
    const data = createJobData({ depth: 3 });

    await processCrawlJob(data, deps);

    // maxDepth is 3, current depth is 3, so no links should be enqueued
    expect(deps.queues.crawl.add).not.toHaveBeenCalled();
  });

  it('marks task as completed on success', async () => {
    const data = createJobData();

    await processCrawlJob(data, deps);

    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[0]).toEqual(['task-1', 'tenant-1', 'in_progress']);
    expect(updateStatusCalls[updateStatusCalls.length - 1]).toEqual([
      'task-1',
      'tenant-1',
      'completed',
    ]);
  });

  it('marks task as failed on error', async () => {
    (deps.crawler.crawl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection timeout'),
    );
    const data = createJobData();

    await processCrawlJob(data, deps);

    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[0]).toEqual(['task-1', 'tenant-1', 'in_progress']);
    expect(updateStatusCalls[1]).toEqual(['task-1', 'tenant-1', 'failed']);
  });

  it('enqueues schema evolution job after batch threshold', async () => {
    // Override job config to enable evolution with batchSize 10
    const jobWithEvolution = {
      id: 'job-1',
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      status: 'running' as const,
      config: {
        tenantId: 'tenant-1',
        name: 'Test Job',
        description: 'Scrape product data',
        seedUrls: ['https://example.com'],
        crawl: {
          maxDepth: 3,
          maxPages: 100,
          concurrency: 5,
          crawlerType: 'playwright' as const,
        },
        schema: {
          mode: 'discovery' as const,
          evolutionConfig: {
            enabled: true,
            batchSize: 10,
            maxFields: 50,
            relevanceThresholds: {},
            tableStrategy: 'auto' as const,
          },
        },
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
        },
      },
      stats: {},
      schemaId: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithEvolution);

    // Mock findByJob to return exactly batchSize (10) extractions
    const mockExtractions = Array.from({ length: 10 }, (_, i) => ({
      id: `extraction-${i + 1}`,
      jobId: 'job-1',
      pageId: `page-${i + 1}`,
      schemaVersion: 1,
      data: { title: `Product ${i + 1}` },
      metadata: {},
    }));
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue(mockExtractions);

    const data = createJobData();
    await processCrawlJob(data, deps);

    expect(deps.queues.schemaEvolution.add).toHaveBeenCalledWith(
      expect.stringMatching(/^schema-evolution:job-1:v\d+$/),
      {
        jobId: 'job-1',
        tenantId: 'tenant-1',
        extractionIds: mockExtractions.map((e) => e.id),
      },
    );
  });

  it('does NOT trigger schema evolution when batch threshold not met', async () => {
    // Override job config to enable evolution with batchSize 10
    const jobWithEvolution = {
      id: 'job-1',
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      status: 'running' as const,
      config: {
        tenantId: 'tenant-1',
        name: 'Test Job',
        description: 'Scrape product data',
        seedUrls: ['https://example.com'],
        crawl: {
          maxDepth: 3,
          maxPages: 100,
          concurrency: 5,
          crawlerType: 'playwright' as const,
        },
        schema: {
          mode: 'discovery' as const,
          evolutionConfig: {
            enabled: true,
            batchSize: 10,
            maxFields: 50,
            relevanceThresholds: {},
            tableStrategy: 'auto' as const,
          },
        },
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
        },
      },
      stats: {},
      schemaId: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithEvolution);

    // Mock findByJob to return fewer than batchSize (3 extractions)
    const mockExtractions = Array.from({ length: 3 }, (_, i) => ({
      id: `extraction-${i + 1}`,
      jobId: 'job-1',
      pageId: `page-${i + 1}`,
      schemaVersion: 1,
      data: { title: `Product ${i + 1}` },
      metadata: {},
    }));
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue(mockExtractions);

    const data = createJobData();
    await processCrawlJob(data, deps);

    expect(deps.queues.schemaEvolution.add).not.toHaveBeenCalled();
  });

  it('handles crawler throwing an error gracefully', async () => {
    (deps.crawler.crawl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED: Connection refused'),
    );
    const data = createJobData();

    // Should not throw — error is caught internally
    await expect(processCrawlJob(data, deps)).resolves.toBeUndefined();

    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[0]).toEqual(['task-1', 'tenant-1', 'in_progress']);
    expect(updateStatusCalls[1]).toEqual(['task-1', 'tenant-1', 'failed']);

    // No page should be created
    expect(deps.pageRepo.create).not.toHaveBeenCalled();
    expect(deps.extractor.extract).not.toHaveBeenCalled();
  });

  it('handles extraction failure by failing the task', async () => {
    (deps.extractor.extract as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('LLM rate limit exceeded'),
    );
    const data = createJobData();

    // The crawl worker wraps everything in a single try/catch,
    // so an extraction failure causes the task to fail
    await expect(processCrawlJob(data, deps)).resolves.toBeUndefined();

    // Crawler was still called successfully
    expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    // Content was still stored
    expect(deps.contentStore.store).toHaveBeenCalled();
    // Page was still created
    expect(deps.pageRepo.create).toHaveBeenCalled();

    // But the task is marked as failed because the error propagated
    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[updateStatusCalls.length - 1]).toEqual([
      'task-1',
      'tenant-1',
      'failed',
    ]);
  });

  it('handles content store failure gracefully', async () => {
    (deps.contentStore.store as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Storage backend unavailable'),
    );
    const data = createJobData();

    await expect(processCrawlJob(data, deps)).resolves.toBeUndefined();

    // Crawler was called
    expect(deps.crawler.crawl).toHaveBeenCalled();
    // Task is marked as failed
    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[updateStatusCalls.length - 1]).toEqual([
      'task-1',
      'tenant-1',
      'failed',
    ]);
    // Extraction should not be attempted since page creation failed
    expect(deps.extractor.extract).not.toHaveBeenCalled();
  });

  it('skips extraction when page is classified as irrelevant', async () => {
    (deps.classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      classification: 'irrelevant',
      confidence: 0.85,
      strategy: 'skip',
      reasoning: 'Navigation page, not a product page',
    });
    const data = createJobData();

    await processCrawlJob(data, deps);

    // Crawl and content store should still happen
    expect(deps.crawler.crawl).toHaveBeenCalled();
    expect(deps.contentStore.store).toHaveBeenCalled();
    expect(deps.pageRepo.create).toHaveBeenCalled();

    // Classification was recorded
    expect(deps.taskRepo.updateClassification).toHaveBeenCalledWith(
      'task-1',
      'tenant-1',
      'irrelevant',
    );

    // But no extraction should have happened
    // Note: schemaRepo.findLatest may be called by the orchestrator for caching purposes
    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(deps.extractionRepo.store).not.toHaveBeenCalled();

    // Task should still be marked as completed (crawl succeeded)
    const updateStatusCalls = (deps.taskRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStatusCalls[updateStatusCalls.length - 1]).toEqual([
      'task-1',
      'tenant-1',
      'completed',
    ]);
  });

  it('does NOT trigger schema evolution for fixed schema mode', async () => {
    // Override job config with fixed mode (no evolutionConfig)
    const fixedSchemaJob = {
      id: 'job-1',
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      status: 'running' as const,
      config: {
        tenantId: 'tenant-1',
        name: 'Test Job',
        description: 'Scrape product data',
        seedUrls: ['https://example.com'],
        crawl: {
          maxDepth: 3,
          maxPages: 100,
          concurrency: 5,
          crawlerType: 'playwright' as const,
        },
        schema: {
          mode: 'fixed' as const,
        },
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
        },
      },
      stats: {},
      schemaId: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(fixedSchemaJob);

    const data = createJobData();
    await processCrawlJob(data, deps);

    expect(deps.queues.schemaEvolution.add).not.toHaveBeenCalled();
  });

  describe('link evaluation', () => {
    it('calls linkEvaluator.evaluate when evaluator is provided', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue([
          { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.9, expectedContent: 'single_entry', priority: 'high', reasoning: 'Product page' },
          { url: 'https://example.com/product/3', text: 'Product 3', relevanceScore: 0.8, expectedContent: 'single_entry', priority: 'medium', reasoning: 'Product page' },
        ]),
      };
      (deps as any).linkEvaluator = mockEvaluator;
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        [
          { url: 'https://example.com/product/2', text: 'Product 2' },
          { url: 'https://example.com/product/3', text: 'Product 3' },
        ],
        expect.objectContaining({
          description: 'Scrape product data',
          seedDomains: ['example.com'],
          currentDepth: 1,
          maxDepth: 3,
        }),
        expect.objectContaining({ version: 1 }),
      );
    });

    it('filters out links below 0.3 relevance threshold', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue([
          { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.9, expectedContent: 'single_entry', priority: 'high', reasoning: 'Product page' },
          { url: 'https://example.com/product/3', text: 'Product 3', relevanceScore: 0.1, expectedContent: 'unknown', priority: 'low', reasoning: 'About page' },
        ]),
      };
      (deps as any).linkEvaluator = mockEvaluator;
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      // Only 1 link should be enqueued (product/2 with score 0.9)
      expect(deps.taskRepo.enqueue).toHaveBeenCalledTimes(1);
      expect(deps.taskRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/product/2' }),
      );
    });

    it('maps high priority to BullMQ priority 1', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue([
          { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.9, expectedContent: 'single_entry', priority: 'high', reasoning: 'Product page' },
        ]),
      };
      (deps as any).linkEvaluator = mockEvaluator;
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      expect(deps.queues.crawl.add).toHaveBeenCalledWith(
        'crawl:https://example.com/product/2',
        expect.any(Object),
        { priority: 1 },
      );
    });

    it('maps medium priority to BullMQ priority 5', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue([
          { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.8, expectedContent: 'listing', priority: 'medium', reasoning: 'Listing page' },
        ]),
      };
      (deps as any).linkEvaluator = mockEvaluator;
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      expect(deps.queues.crawl.add).toHaveBeenCalledWith(
        'crawl:https://example.com/product/2',
        expect.any(Object),
        { priority: 5 },
      );
    });

    it('maps low priority to BullMQ priority 10', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue([
          { url: 'https://example.com/product/2', text: 'Product 2', relevanceScore: 0.5, expectedContent: 'unknown', priority: 'low', reasoning: 'Low priority' },
        ]),
      };
      (deps as any).linkEvaluator = mockEvaluator;
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      expect(deps.queues.crawl.add).toHaveBeenCalledWith(
        'crawl:https://example.com/product/2',
        expect.any(Object),
        { priority: 10 },
      );
    });

    it('enqueues all links without priority when no evaluator is provided', async () => {
      // deps.linkEvaluator is undefined by default
      const data = createJobData({ depth: 1 });

      await processCrawlJob(data, deps);

      // Both links should be enqueued without priority
      expect(deps.queues.crawl.add).toHaveBeenCalledTimes(2);
      expect(deps.queues.crawl.add).toHaveBeenCalledWith(
        'crawl:https://example.com/product/2',
        expect.objectContaining({ url: 'https://example.com/product/2' }),
      );
      expect(deps.queues.crawl.add).toHaveBeenCalledWith(
        'crawl:https://example.com/product/3',
        expect.objectContaining({ url: 'https://example.com/product/3' }),
      );
    });
  });

  describe('tenant page quota enforcement', () => {
    it('skips task when tenant page quota exceeded', async () => {
      const data = createJobData();
      (deps as any).tenantRepo = {
        getQuotas: vi.fn().mockResolvedValue({ maxPagesPerJob: 10 }),
      };
      // Add findByJob to taskRepo since it's not in the base mock
      (deps.taskRepo as any).findByJob = vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, status: 'completed' })),
      );

      await processCrawlJob(data, deps);

      expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'skipped');
      expect(deps.crawler.crawl).not.toHaveBeenCalled();
    });

    it('allows crawl when under page quota', async () => {
      const data = createJobData();
      (deps as any).tenantRepo = {
        getQuotas: vi.fn().mockResolvedValue({ maxPagesPerJob: 100 }),
      };
      (deps.taskRepo as any).findByJob = vi.fn().mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ id: `task-${i}`, status: 'completed' })),
      );

      await processCrawlJob(data, deps);

      expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    });

    it('fails open when page quota check errors', async () => {
      const data = createJobData();
      (deps as any).tenantRepo = {
        getQuotas: vi.fn().mockRejectedValue(new Error('DB error')),
      };

      await processCrawlJob(data, deps);

      // Crawl proceeds despite quota check failure
      expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    });
  });

  describe('pipeline hardening integration', () => {
    it('skips task when page budget is exhausted', async () => {
      const data = createJobData();
      (deps as any).pageBudget = {
        tryIncrement: () => false,
        count: 100,
        remaining: 0,
        isExhausted: true,
        maxPages: 100,
      };

      await processCrawlJob(data, deps);

      expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'skipped');
      expect(deps.crawler.crawl).not.toHaveBeenCalled();
    });

    it('skips task when blocked by robots.txt', async () => {
      const data = createJobData();
      (deps as any).robotsChecker = {
        isAllowed: vi.fn().mockResolvedValue(false),
        getCrawlDelay: vi.fn(),
      };

      await processCrawlJob(data, deps);

      expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'skipped');
      expect(deps.crawler.crawl).not.toHaveBeenCalled();
    });

    it('waits for rate limiter before crawling', async () => {
      const data = createJobData();
      const waitForSlot = vi.fn().mockResolvedValue(undefined);
      (deps as any).rateLimiter = { waitForSlot };

      await processCrawlJob(data, deps);

      expect(waitForSlot).toHaveBeenCalledWith(data.url, undefined);
      expect(deps.crawler.crawl).toHaveBeenCalled();
    });

    it('enqueues reconciliation when crawl is naturally complete', async () => {
      const data = createJobData();
      (deps as any).completionChecker = {
        isComplete: vi.fn().mockResolvedValue({
          complete: true,
          reason: 'all_tasks_done',
          stats: { pending: 0, inProgress: 1, completed: 50, failed: 0, skipped: 0 },
        }),
      };

      await processCrawlJob(data, deps);

      expect(deps.queues.reconciliation.add).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation:'),
        expect.objectContaining({ jobId: data.jobId, tenantId: data.tenantId }),
      );
    });

    it('does not enqueue reconciliation when crawl is not complete', async () => {
      const data = createJobData();
      (deps as any).completionChecker = {
        isComplete: vi.fn().mockResolvedValue({
          complete: false,
          stats: { pending: 5, inProgress: 2, completed: 40, failed: 0, skipped: 0 },
        }),
      };

      await processCrawlJob(data, deps);

      expect(deps.queues.reconciliation.add).not.toHaveBeenCalled();
    });
  });

  describe('wrapper-specific behavior', () => {
    it('does not throw when orchestrator throws on crawl error', async () => {
      (deps.crawler.crawl as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection timeout'),
      );
      const data = createJobData();

      // Orchestrator returns error field instead of throwing — worker handles it gracefully
      await expect(processCrawlJob(data, deps)).resolves.toBeUndefined();
    });

    it('does not publish crawl_progress when no links are enqueued', async () => {
      // Use depth at max so no links are enqueued
      const data = createJobData({ depth: 3 });

      const mockPublish = vi.fn();
      (deps as any).eventPublisher = { publish: mockPublish };

      await processCrawlJob(data, deps);

      // task_completed event should still be published
      const taskCompletedCalls = mockPublish.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'task_completed',
      );
      expect(taskCompletedCalls.length).toBe(1);

      // crawl_progress should NOT be published (no links enqueued)
      const crawlProgressCalls = mockPublish.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'crawl_progress',
      );
      expect(crawlProgressCalls.length).toBe(0);
    });
  });
});
