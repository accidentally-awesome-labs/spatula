import { describe, it, expect } from 'vitest';
import { estimateCost } from '../../../src/cost/estimator.js';
import type { JobConfig } from '../../../src/types/job.js';

function createMinimalConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    name: 'Test Job',
    description: 'Test crawl',
    seedUrls: ['https://example.com'],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  } as JobConfig;
}

describe('estimateCost', () => {
  it('returns estimate with all required fields', () => {
    const config = createMinimalConfig();
    const estimate = estimateCost(config);

    expect(estimate).toHaveProperty('estimatedPages');
    expect(estimate).toHaveProperty('totalTokens');
    expect(estimate).toHaveProperty('totalCostUsd');
    expect(estimate).toHaveProperty('confidence');
    expect(estimate).toHaveProperty('llmCallBreakdown');
    expect(estimate.estimatedPages).toBeGreaterThan(0);
    expect(estimate.totalTokens).toBeGreaterThan(0);
    expect(estimate.totalCostUsd).toBeGreaterThan(0);
  });

  it('estimates page count from maxDepth heuristic', () => {
    const depth0 = estimateCost(createMinimalConfig({
      crawl: { maxDepth: 0, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    } as any));
    expect(depth0.estimatedPages).toBe(1); // depth 0 = seed pages only

    const depth1 = estimateCost(createMinimalConfig({
      crawl: { maxDepth: 1, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    } as any));
    expect(depth1.estimatedPages).toBeLessThanOrEqual(1000);
    expect(depth1.estimatedPages).toBeGreaterThan(1);
  });

  it('caps estimated pages at maxPages', () => {
    const config = createMinimalConfig({
      crawl: { maxDepth: 5, maxPages: 100, concurrency: 5, crawlerType: 'playwright' as const },
    } as any);
    const estimate = estimateCost(config);
    expect(estimate.estimatedPages).toBeLessThanOrEqual(100);
  });

  it('returns zero cost for Ollama models', () => {
    const config = createMinimalConfig({
      llm: { primaryModel: 'llama3.2:8b' },
    } as any);
    const estimate = estimateCost(config);
    expect(estimate.totalCostUsd).toBe(0);
    expect(estimate.totalTokens).toBeGreaterThan(0); // tokens still counted
  });

  it('sets confidence based on depth and maxPages', () => {
    const shallow = estimateCost(createMinimalConfig({
      crawl: { maxDepth: 1, maxPages: 100, concurrency: 5, crawlerType: 'playwright' as const },
    } as any));
    expect(shallow.confidence).toBe('high');

    const deep = estimateCost(createMinimalConfig({
      crawl: { maxDepth: 3, maxPages: 5000, concurrency: 5, crawlerType: 'playwright' as const },
    } as any));
    expect(deep.confidence).toBe('low');

    // maxPages > 1000 at shallow depth should still be low
    const shallowButWide = estimateCost(createMinimalConfig({
      crawl: { maxDepth: 1, maxPages: 5000, concurrency: 5, crawlerType: 'playwright' as const },
    } as any));
    expect(shallowButWide.confidence).toBe('low');
  });

  it('includes per-purpose breakdown', () => {
    const estimate = estimateCost(createMinimalConfig());

    expect(estimate.llmCallBreakdown.length).toBeGreaterThan(0);
    for (const entry of estimate.llmCallBreakdown) {
      expect(entry).toHaveProperty('purpose');
      expect(entry).toHaveProperty('calls');
      expect(entry).toHaveProperty('tokens');
      expect(entry).toHaveProperty('costUsd');
      expect(entry.calls).toBeGreaterThanOrEqual(0);
      expect(entry.tokens).toBeGreaterThanOrEqual(0);
      expect(entry.costUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('accounts for multiple seed URLs at depth 0', () => {
    const config = createMinimalConfig({
      seedUrls: ['https://a.com', 'https://b.com', 'https://c.com'],
      crawl: { maxDepth: 0, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    } as any);
    const estimate = estimateCost(config);
    expect(estimate.estimatedPages).toBe(3);
  });

  it('handles model overrides in breakdown', () => {
    const config = createMinimalConfig({
      llm: {
        primaryModel: 'anthropic/claude-sonnet-4-20250514',
        modelOverrides: {
          linkEvaluation: 'anthropic/claude-3-haiku-20240307',
          pageRelevance: 'anthropic/claude-3-haiku-20240307',
        },
      },
    } as any);
    const estimate = estimateCost(config);
    // Haiku is cheaper — total cost should be less than all-Sonnet
    const allSonnet = estimateCost(createMinimalConfig());
    expect(estimate.totalCostUsd).toBeLessThan(allSonnet.totalCostUsd);
  });
});
