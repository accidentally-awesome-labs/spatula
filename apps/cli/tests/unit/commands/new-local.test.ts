import { describe, it, expect } from 'vitest';
import { configToYaml } from '../../../src/commands/new.js';
import type { JobConfig } from '@spatula/core';

describe('configToYaml', () => {
  it('converts JobConfig to spatula.yaml format', () => {
    const config: JobConfig = {
      tenantId: 'test',
      name: 'My Crawl',
      description: 'Extract product data',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    };
    const yaml = configToYaml(config);
    expect(yaml).toContain('name: My Crawl');
    expect(yaml).toContain('https://example.com');
  });

  it('includes user-defined fields when present', () => {
    const config: JobConfig = {
      tenantId: 'test',
      name: 'Products',
      description: 'Extract products',
      seedUrls: ['https://shop.com'],
      crawl: { maxDepth: 1, maxPages: 50, concurrency: 3, crawlerType: 'playwright' },
      schema: {
        mode: 'hybrid',
        userFields: [
          { name: 'product_name', type: 'string', description: 'Product name', required: true },
          { name: 'price', type: 'currency', description: 'Price', required: false },
        ],
      },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    };
    const yaml = configToYaml(config);
    expect(yaml).toContain('product_name');
    expect(yaml).toContain('price');
  });

  it('omits default values to keep YAML clean', () => {
    const config: JobConfig = {
      tenantId: 'test',
      name: 'Defaults',
      description: 'Test defaults',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    };
    const yaml = configToYaml(config);
    expect(yaml).not.toContain('limit');
    expect(yaml).not.toContain('crawler');
  });

  it('outputs valid YAML that can be parsed back', async () => {
    const { parse: parseYaml } = await import('yaml');
    const config: JobConfig = {
      tenantId: 'test',
      name: 'Round Trip',
      description: 'Test round trip',
      seedUrls: ['https://example.com', 'https://other.com'],
      crawl: { maxDepth: 3, maxPages: 500, concurrency: 5, crawlerType: 'firecrawl' },
      schema: { mode: 'hybrid' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    };
    const yamlStr = configToYaml(config);
    const parsed = parseYaml(yamlStr);
    expect(parsed.name).toBe('Round Trip');
    expect(parsed.seeds).toEqual(['https://example.com', 'https://other.com']);
    expect(parsed.depth).toBe(3);
    expect(parsed.limit).toBe(500);
    expect(parsed.crawler).toBe('firecrawl');
  });
});
