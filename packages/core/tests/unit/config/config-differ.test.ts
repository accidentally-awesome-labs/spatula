import { describe, it, expect } from 'vitest';
import { diffConfigs } from '../../../src/config/config-differ.js';
import type { JobConfig } from '../../../src/types/job.js';

function createBaseConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    name: 'Test',
    description: 'Test crawl',
    seedUrls: ['https://example.com'],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    schema: {
      mode: 'discovery' as const,
      userFields: [],
    },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  } as JobConfig;
}

describe('diffConfigs', () => {
  it('returns hasChanges=false for identical configs', () => {
    const config = createBaseConfig();
    const diff = diffConfigs(config, config);
    expect(diff.hasChanges).toBe(false);
  });

  it('detects added seeds', () => {
    const current = createBaseConfig({ seedUrls: ['https://example.com', 'https://new.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://example.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.seedsAdded).toEqual(['https://new.com']);
    expect(diff.hasChanges).toBe(true);
  });

  it('detects removed seeds', () => {
    const current = createBaseConfig({ seedUrls: ['https://example.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://example.com', 'https://old.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.seedsRemoved).toEqual(['https://old.com']);
  });

  it('detects added fields', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsAdded).toHaveLength(1);
    expect(diff.fieldsAdded[0].name).toBe('price');
  });

  it('detects removed fields', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsRemoved).toEqual(['price']);
  });

  it('detects modified fields (type change)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'price', type: 'string' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsModified).toHaveLength(1);
    expect(diff.fieldsModified[0].name).toBe('price');
    expect(diff.fieldsModified[0].changes).toContainEqual({
      property: 'type',
      from: 'currency',
      to: 'string',
    });
  });

  it('detects modified fields (enumValues change)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'status',
            type: 'enum' as const,
            description: 'Status',
            required: false,
            enumValues: ['active', 'inactive', 'pending'],
          },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'status',
            type: 'enum' as const,
            description: 'Status',
            required: false,
            enumValues: ['active', 'inactive'],
          },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsModified).toHaveLength(1);
    expect(diff.fieldsModified[0].changes).toContainEqual({
      property: 'enumValues',
      from: ['active', 'inactive'],
      to: ['active', 'inactive', 'pending'],
    });
  });

  it('detects modified fields (normalization change)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'price',
            type: 'currency' as const,
            description: 'Price',
            required: false,
            normalization: { type: 'currency' as const, targetCurrency: 'EUR' },
          },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'price',
            type: 'currency' as const,
            description: 'Price',
            required: false,
            normalization: { type: 'currency' as const, targetCurrency: 'USD' },
          },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsModified).toHaveLength(1);
    expect(diff.fieldsModified[0].changes).toContainEqual({
      property: 'normalization',
      from: { type: 'currency', targetCurrency: 'USD' },
      to: { type: 'currency', targetCurrency: 'EUR' },
    });
  });

  it('normalization change triggers re-extraction in impact', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'price',
            type: 'currency' as const,
            description: 'Price',
            required: false,
            normalization: { type: 'currency' as const, targetCurrency: 'EUR' },
          },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'price',
            type: 'currency' as const,
            description: 'Price',
            required: false,
            normalization: { type: 'currency' as const, targetCurrency: 'USD' },
          },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.impact.pagesNeedingReextraction).toBeNull();
  });

  it('detects potential field renames (same type, one removed + one added)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'name', type: 'string' as const, description: 'Name', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'product_name',
            type: 'string' as const,
            description: 'Product Name',
            required: false,
          },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.potentialRenames).toHaveLength(1);
    expect(diff.potentialRenames[0]).toEqual({ from: 'product_name', to: 'name', type: 'string' });
    // Matched fields are removed from added/removed lists
    expect(diff.fieldsAdded).toEqual([]);
    expect(diff.fieldsRemoved).toEqual([]);
  });

  it('detects schema mode change', () => {
    const current = createBaseConfig({ schema: { mode: 'hybrid' as const } } as any);
    const previous = createBaseConfig({ schema: { mode: 'fixed' as const } } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.schemaModeChanged).toEqual({ from: 'fixed', to: 'hybrid' });
  });

  it('detects crawl setting changes', () => {
    const current = createBaseConfig({
      crawl: { maxDepth: 3, maxPages: 2000, concurrency: 10, crawlerType: 'firecrawl' as const },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.crawlChanged.maxDepth).toEqual({ from: 2, to: 3 });
    expect(diff.crawlChanged.maxPages).toEqual({ from: 1000, to: 2000 });
    expect(diff.crawlChanged.concurrency).toEqual({ from: 5, to: 10 });
    expect(diff.crawlChanged.crawlerType).toEqual({ from: 'playwright', to: 'firecrawl' });
  });

  it('detects proxy changes', () => {
    const current = createBaseConfig({
      crawl: {
        maxDepth: 2,
        maxPages: 1000,
        concurrency: 5,
        crawlerType: 'playwright' as const,
        proxy: { url: 'socks5://localhost:1080' },
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.crawlChanged.proxyChanged).toBe(true);
  });

  it('detects LLM model change', () => {
    const current = createBaseConfig({
      llm: { primaryModel: 'llama3.2:8b' },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.llmChanged).toBe(true);
  });

  it('detects reconciliation strategy change', () => {
    const current = createBaseConfig({
      reconciliation: {
        matchStrategy: 'fuzzy_name' as const,
        conflictResolution: 'most_complete' as const,
        fuzzyMatchThreshold: 0.85,
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.reconciliationChanged).toBe(true);
  });

  it('computes impact: new seeds to enqueue', () => {
    const current = createBaseConfig({ seedUrls: ['https://a.com', 'https://b.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://a.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.impact.newTasksToEnqueue).toBe(1);
  });

  it('computes impact: force full reconciliation on strategy change', () => {
    const current = createBaseConfig({
      reconciliation: {
        matchStrategy: 'fuzzy_name' as const,
        conflictResolution: 'most_complete' as const,
        fuzzyMatchThreshold: 0.85,
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.impact.forceFullReconciliation).toBe(true);
  });

  it('returns empty diff for no fields on both sides', () => {
    const config = createBaseConfig({ schema: { mode: 'discovery' as const } } as any);
    const diff = diffConfigs(config, config);
    expect(diff.fieldsAdded).toEqual([]);
    expect(diff.fieldsRemoved).toEqual([]);
    expect(diff.fieldsModified).toEqual([]);
    expect(diff.potentialRenames).toEqual([]);
  });

  it('safetyChanged is false and does not affect hasChanges', () => {
    const config = createBaseConfig();
    const diff = diffConfigs(config, config);
    expect(diff.safetyChanged).toBe(false);
    expect(diff.hasChanges).toBe(false);
  });
});

function makeConfig(overrides: { fields: any[] }) {
  return createBaseConfig({
    schema: {
      mode: 'hybrid' as const,
      userFields: overrides.fields,
    },
  } as any);
}

describe('diffConfigs nested fields', () => {
  it('detects arrayItemType changes', () => {
    const prev = makeConfig({
      fields: [
        {
          name: 'tags',
          description: 'Tags',
          type: 'array',
          arrayItemType: { name: 'item', description: 'tag', type: 'string', required: false },
        },
      ],
    });
    const curr = makeConfig({
      fields: [
        {
          name: 'tags',
          description: 'Tags',
          type: 'array',
          arrayItemType: { name: 'item', description: 'tag', type: 'number', required: false },
        },
      ],
    });
    const diff = diffConfigs(curr, prev);
    expect(diff.fieldsModified).toHaveLength(1);
    const tagChanges = diff.fieldsModified[0].changes;
    const arrayChange = tagChanges.find((c) => c.property === 'arrayItemType');
    expect(arrayChange).toBeDefined();
    expect(arrayChange!.nestedChanges).toBeDefined();
    expect(arrayChange!.nestedChanges).toContainEqual(
      expect.objectContaining({ property: 'type', from: 'string', to: 'number' }),
    );
  });

  it('detects objectFields added/removed/modified', () => {
    const prev = makeConfig({
      fields: [
        {
          name: 'address',
          description: 'Address',
          type: 'object',
          objectFields: [
            { name: 'street', description: 'Street', type: 'string', required: true },
            { name: 'zip', description: 'Zip', type: 'string', required: false },
          ],
        },
      ],
    });
    const curr = makeConfig({
      fields: [
        {
          name: 'address',
          description: 'Address',
          type: 'object',
          objectFields: [
            { name: 'street', description: 'Street', type: 'string', required: false },
            { name: 'city', description: 'City', type: 'string', required: true },
          ],
        },
      ],
    });
    const diff = diffConfigs(curr, prev);
    expect(diff.fieldsModified).toHaveLength(1);
    const objChange = diff.fieldsModified[0].changes.find((c) => c.property === 'objectFields');
    expect(objChange).toBeDefined();
    expect(objChange!.addedFields).toContain('city');
    expect(objChange!.removedFields).toContain('zip');
    expect(objChange!.nestedChanges).toContainEqual(
      expect.objectContaining({ property: 'required', from: true, to: false }),
    );
  });

  it('ignores unchanged nested fields', () => {
    const config = makeConfig({
      fields: [
        {
          name: 'tags',
          description: 'Tags',
          type: 'array',
          arrayItemType: { name: 'item', description: 'tag', type: 'string', required: false },
        },
      ],
    });
    const diff = diffConfigs(config, config);
    expect(diff.hasChanges).toBe(false);
  });
});
