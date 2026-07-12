// packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processCrawlTask,
  isValidCrawlUrl,
  shouldTriggerSchemaEvolution,
} from '../../../src/pipeline/crawl-orchestrator.js';
import type { CrawlOrchestratorDeps, CrawlTaskInput } from '../../../src/pipeline/types.js';

describe('isValidCrawlUrl', () => {
  it('accepts valid HTTP URLs', () => {
    expect(isValidCrawlUrl('https://example.com/page')).toBe(true);
    expect(isValidCrawlUrl('http://example.com')).toBe(true);
  });

  it('rejects non-HTTP protocols', () => {
    expect(isValidCrawlUrl('ftp://example.com')).toBe(false);
    expect(isValidCrawlUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects localhost and private IPs', () => {
    expect(isValidCrawlUrl('http://localhost/admin')).toBe(false);
    expect(isValidCrawlUrl('http://localhost./admin')).toBe(false);
    expect(isValidCrawlUrl('http://127.0.0.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://0.0.0.0/admin')).toBe(false);
    expect(isValidCrawlUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isValidCrawlUrl('http://192.168.1.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://10.0.0.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://172.16.0.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://[::1]/admin')).toBe(false);
    expect(isValidCrawlUrl('http://[fd00::1]/admin')).toBe(false);
    expect(isValidCrawlUrl('http://[fe80::1]/admin')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidCrawlUrl('not-a-url')).toBe(false);
    expect(isValidCrawlUrl('')).toBe(false);
  });
});

function createMockDeps(): CrawlOrchestratorDeps {
  return {
    crawler: {
      type: 'playwright' as const,
      crawl: vi.fn().mockResolvedValue({
        url: 'https://example.com/product/1',
        html: '<html><body><h1>Product 1</h1></body></html>',
        title: 'Product 1',
        statusCode: 200,
        contentType: 'text/html',
        links: [{ url: 'https://example.com/product/2', text: 'Product 2' }],
        metadata: {
          crawledAt: new Date(),
          responseTimeMs: 250,
          contentLength: 45,
          crawlerType: 'playwright' as const,
        },
      }),
      close: vi.fn(),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({ classification: 'single_entry', confidence: 0.9 }),
    },
    extractor: {
      extract: vi.fn().mockResolvedValue({
        data: { title: 'Product 1' },
        metadata: {
          confidence: 0.95,
          modelUsed: 'test-model',
          tokensUsed: 100,
          extractionTimeMs: 500,
          unmappedFields: [],
        },
      }),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('ref-abc'),
      retrieve: vi.fn(),
      delete: vi.fn(),
      storeBinary: vi.fn(),
      retrieveBinary: vi.fn(),
    },
    linkEvaluator: undefined,
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      updateClassification: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue({ id: 'child-task-1' }),
    },
    pageRepo: {
      findByContentHash: vi.fn().mockResolvedValue(null),
      findByIds: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'page-1' }),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'job-1',
        config: {
          tenantId: 'tenant-1',
          name: 'Test',
          description: 'Scrape products',
          seedUrls: ['https://example.com'],
          crawl: { maxDepth: 3, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
          schema: { mode: 'discovery' },
        },
      }),
      updateStatus: vi.fn(),
    },
    extractionRepo: {
      store: vi.fn().mockResolvedValue(undefined),
      findByJob: vi.fn().mockResolvedValue([]),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: 'Title' }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
      create: vi.fn(),
    },
    eventPublisher: { publish: vi.fn() },
  };
}

const defaultInput: CrawlTaskInput = {
  taskId: 'task-1',
  jobId: 'job-1',
  tenantId: 'tenant-1',
  url: 'https://example.com/product/1',
  depth: 0,
};

describe('processCrawlTask', () => {
  it('crawls URL, classifies, and extracts data', async () => {
    const deps = createMockDeps();
    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    expect(deps.classifier.classify).toHaveBeenCalledTimes(1);
    expect(deps.extractor.extract).toHaveBeenCalledTimes(1);
    expect(deps.extractionRepo.store).toHaveBeenCalledTimes(1);
    expect(result.extracted).toBe(true);
    expect(result.classification).toBe('single_entry');
  });

  it('uses extractMany for multi-entry pages and stores each meaningful record', async () => {
    const deps = createMockDeps();
    (deps.classifier.classify as any).mockResolvedValue({
      classification: 'multiple_entries',
      strategy: 'list_extraction',
      confidence: 0.9,
    });
    const extractMany = vi.fn().mockResolvedValue([
      {
        data: { title: 'Product A' },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test-model',
          tokensUsed: 100,
          extractionTimeMs: 500,
          unmappedFields: [],
        },
      },
      {
        data: {},
        metadata: {
          confidence: 0,
          modelUsed: 'test-model',
          tokensUsed: 0,
          extractionTimeMs: 100,
          unmappedFields: [],
        },
      },
      {
        data: { title: 'Product B' },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test-model',
          tokensUsed: 100,
          extractionTimeMs: 500,
          unmappedFields: [],
        },
      },
    ]);
    (deps.extractor as any).extractMany = extractMany;

    const result = await processCrawlTask(defaultInput, deps);

    expect(extractMany).toHaveBeenCalledTimes(1);
    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(deps.extractionRepo.store).toHaveBeenCalledTimes(2);
    expect(deps.extractionRepo.store).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Product A' } }),
    );
    expect(deps.extractionRepo.store).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Product B' } }),
    );
    expect(result.extracted).toBe(true);
  });

  it('does not store empty extraction payloads', async () => {
    const deps = createMockDeps();
    (deps.extractor.extract as any).mockResolvedValue({
      data: { title: null, price: '' },
      metadata: {
        confidence: 0,
        modelUsed: 'test-model',
        tokensUsed: 0,
        extractionTimeMs: 500,
        unmappedFields: [],
      },
    });

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.extractionRepo.store).not.toHaveBeenCalled();
    expect(result.extracted).toBe(false);
  });

  it('deduplicates content by hash', async () => {
    const deps = createMockDeps();
    (deps.pageRepo.findByContentHash as any).mockResolvedValue({ id: 'existing-page' });

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.contentStore.store).not.toHaveBeenCalled();
    expect(deps.pageRepo.create).not.toHaveBeenCalled();
    expect(result.deduplicated).toBe(true);
    expect(result.pageId).toBe('existing-page');
  });

  it('skips extraction for non-extractable classifications', async () => {
    const deps = createMockDeps();
    (deps.classifier.classify as any).mockResolvedValue({
      classification: 'navigation',
      confidence: 0.8,
    });

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(result.extracted).toBe(false);
  });

  it('returns valid links filtered by URL validation', async () => {
    const deps = createMockDeps();
    (deps.crawler.crawl as any).mockResolvedValue({
      url: 'https://example.com',
      html: '<html></html>',
      title: '',
      statusCode: 200,
      links: [
        { url: 'https://example.com/valid', text: 'Valid' },
        { url: 'http://localhost/admin', text: 'Invalid' },
        { url: 'javascript:alert(1)', text: 'XSS' },
      ],
      metadata: {
        crawledAt: new Date(),
        responseTimeMs: 100,
        contentLength: 10,
        crawlerType: 'playwright',
      },
    });
    (deps.classifier.classify as any).mockResolvedValue({
      classification: 'navigation',
      confidence: 0.8,
    });

    const result = await processCrawlTask(defaultInput, deps);

    expect(result.linksFound).toHaveLength(1);
    expect(result.linksFound[0].url).toBe('https://example.com/valid');
  });

  it('does not return links when at max depth', async () => {
    const deps = createMockDeps();
    const input = { ...defaultInput, depth: 3 }; // maxDepth is 3

    const result = await processCrawlTask(input, deps);

    expect(result.linksFound).toHaveLength(0);
  });

  it('marks task as skipped when job not found', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue(null);

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'skipped');
    expect(result.classification).toBe('unknown');
  });

  it('marks task as failed and returns error on crawl error', async () => {
    const deps = createMockDeps();
    (deps.crawler.crawl as any).mockRejectedValue(new Error('Network timeout'));

    const result = await processCrawlTask(defaultInput, deps);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Crawl task failed');
    expect(result.pageId).toBe('');
    expect(result.classification).toBe('unknown');
    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'failed');
  });

  it('publishes task_completed event', async () => {
    const deps = createMockDeps();
    await processCrawlTask(defaultInput, deps);

    expect(deps.eventPublisher!.publish).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        type: 'task_completed',
        data: expect.objectContaining({
          url: 'https://example.com/product/1',
          taskId: 'task-1',
        }),
      }),
    );
  });
});

describe('shouldTriggerSchemaEvolution', () => {
  it('returns false when evolution is disabled', async () => {
    const deps = createMockDeps();

    const result = await shouldTriggerSchemaEvolution(
      'job-1',
      'tenant-1',
      { schemaVersion: 1, evolutionConfig: null },
      { extractionRepo: deps.extractionRepo },
    );
    expect(result.trigger).toBe(false);
  });

  it('returns true when batch size is met', async () => {
    const deps = createMockDeps();
    (deps.extractionRepo.findByJob as any).mockResolvedValue([
      { id: 'e1' },
      { id: 'e2' },
      { id: 'e3' },
    ]);

    const result = await shouldTriggerSchemaEvolution(
      'job-1',
      'tenant-1',
      { schemaVersion: 1, evolutionConfig: { enabled: true, batchSize: 3 } },
      { extractionRepo: deps.extractionRepo },
    );
    expect(result.trigger).toBe(true);
    expect(result.extractionIds).toEqual(['e1', 'e2', 'e3']);
  });
});
