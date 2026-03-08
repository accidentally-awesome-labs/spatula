import { describe, it, expect } from 'vitest';
import { JobConfig, JobStatus } from '../../../src/types/job.js';

describe('JobConfig', () => {
  const validConfig = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Audiophile Products',
    description: 'Crawl audiophile product data',
    seedUrls: ['https://head-fi.org', 'https://audiosciencereview.com'],
    crawl: {
      maxDepth: 2,
      maxPages: 5000,
      concurrency: 5,
      crawlerType: 'playwright' as const,
    },
    schema: {
      mode: 'hybrid' as const,
      userFields: [
        { name: 'name', description: 'Product name', type: 'string' as const, required: true },
        { name: 'price', description: 'Price', type: 'currency' as const },
      ],
      evolutionConfig: {
        enabled: true,
        batchSize: 10,
        maxFields: 50,
        relevanceThresholds: {
          requiredMin: 0.85,
          optionalMin: 0.4,
          rareBelow: 0.4,
          minCategorySampleSize: 5,
        },
        tableStrategy: 'auto' as const,
      },
    },
    llm: {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
        linkEvaluation: 'anthropic/claude-haiku-4-5-20251001',
      },
    },
  };

  it('parses a complete valid config', () => {
    const result = JobConfig.parse(validConfig);
    expect(result.name).toBe('Audiophile Products');
    expect(result.seedUrls).toHaveLength(2);
    expect(result.schema.mode).toBe('hybrid');
    expect(result.schema.evolutionConfig?.batchSize).toBe(10);
  });

  it('applies defaults for crawl settings', () => {
    const minimal = {
      ...validConfig,
      crawl: {},
    };
    const result = JobConfig.parse(minimal);
    expect(result.crawl.maxDepth).toBe(2);
    expect(result.crawl.maxPages).toBe(1000);
    expect(result.crawl.concurrency).toBe(5);
    expect(result.crawl.crawlerType).toBe('playwright');
  });

  it('applies default LLM model', () => {
    const result = JobConfig.parse({
      ...validConfig,
      llm: {},
    });
    expect(result.llm.primaryModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('rejects invalid seed URLs', () => {
    expect(() => JobConfig.parse({ ...validConfig, seedUrls: ['not-a-url'] })).toThrow();
  });

  it('rejects invalid tenant UUID', () => {
    expect(() => JobConfig.parse({ ...validConfig, tenantId: 'not-a-uuid' })).toThrow();
  });

  it('rejects crawl depth over 10', () => {
    expect(() =>
      JobConfig.parse({
        ...validConfig,
        crawl: { ...validConfig.crawl, maxDepth: 11 },
      }),
    ).toThrow();
  });

  it('allows discovery mode without userFields', () => {
    const result = JobConfig.parse({
      ...validConfig,
      schema: { mode: 'discovery' },
    });
    expect(result.schema.userFields).toBeUndefined();
  });
});

describe('JobStatus', () => {
  it('accepts all valid statuses', () => {
    const statuses = [
      'pending',
      'queued',
      'running',
      'paused',
      'reconciling',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const status of statuses) {
      expect(JobStatus.parse(status)).toBe(status);
    }
  });

  it('rejects invalid status', () => {
    expect(() => JobStatus.parse('unknown')).toThrow();
  });
});
