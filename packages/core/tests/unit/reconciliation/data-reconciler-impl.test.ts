import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataReconcilerImpl } from '../../../src/reconciliation/data-reconciler-impl.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ReconciliationConfig } from '../../../src/types/job.js';
import type { ExtractionWithSource } from '../../../src/reconciliation/entity-matcher.js';
import type { PipelineAction } from '../../../src/types/actions.js';

// ---------------------------------------------------------------------------
// Mock helper
// ---------------------------------------------------------------------------

function createMockClient(): LLMClient {
  // Returns empty results from any LLM call (source trust evaluator, gap filler)
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ rankings: [], inferences: [] }),
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

const defaultLLMConfig = {
  primaryModel: 'anthropic/claude-sonnet-4-20250514',
};

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function makeSchema(
  fields: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
    normalization?: {
      type: 'text';
      config: { casing?: string; trim?: boolean; collapseWhitespace?: boolean };
    };
  }>,
): SchemaDefinition {
  return {
    version: 1,
    fields: fields.map((f) => ({
      name: f.name,
      description: f.description,
      type: f.type as
        | 'string'
        | 'number'
        | 'boolean'
        | 'url'
        | 'currency'
        | 'enum'
        | 'array'
        | 'object',
      required: f.required,
      normalization: f.normalization,
    })),
    fieldAliases: [],
    createdAt: new Date('2026-03-01'),
    parentVersion: null,
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

let extractionCounter = 0;

function makeExtraction(
  data: Record<string, unknown>,
  overrides?: Partial<ExtractionWithSource>,
): ExtractionWithSource {
  extractionCounter++;
  const id =
    overrides?.id ??
    `550e8400-e29b-41d4-a716-44665544${String(extractionCounter).padStart(4, '0')}`;
  return {
    id,
    jobId: overrides?.jobId ?? '660e8400-e29b-41d4-a716-446655440000',
    pageId: overrides?.pageId ?? '770e8400-e29b-41d4-a716-446655440000',
    schemaVersion: overrides?.schemaVersion ?? 1,
    data,
    metadata: overrides?.metadata ?? {
      confidence: 0.9,
      modelUsed: 'test-model',
      tokensUsed: 100,
      extractionTimeMs: 200,
      unmappedFields: [],
    },
    sourceUrl: overrides?.sourceUrl ?? `https://example-${extractionCounter}.com/product`,
    sourceDomain: overrides?.sourceDomain ?? `example-${extractionCounter}.com`,
    crawledAt: overrides?.crawledAt ?? new Date('2026-03-05'),
  };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const defaultConfig: ReconciliationConfig = {
  matchStrategy: 'exact_name',
  conflictResolution: 'most_common',
  fuzzyMatchThreshold: 0.85,
  enableLLMMatching: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataReconcilerImpl', () => {
  beforeEach(() => {
    extractionCounter = 0;
  });

  it('produces entities with merged data and provenance', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      {
        name: 'product_name',
        description: 'Product name',
        type: 'string',
        required: true,
        normalization: { type: 'text', config: { casing: 'title', trim: true } },
      },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    const ext1 = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'Sony XM5', price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    // Should produce 1 entity (matching on product_name)
    expect(result.entities).toHaveLength(1);

    const entity = result.entities[0];
    // Both extractions should be sources
    expect(entity.sourceExtractions).toHaveLength(2);
    // Merged data should have product_name (normalized via title case)
    expect(entity.mergedData.product_name).toBe('Sony Xm5');
    // Price had a conflict — should be resolved
    expect(entity.mergedData.price).toBeDefined();
    // Field provenance should exist for product_name and price
    expect(entity.fieldProvenance.product_name).toBeDefined();
    expect(entity.fieldProvenance.price).toBeDefined();
    // product_name should not have had a conflict (same value)
    expect(entity.fieldProvenance.product_name.hadConflict).toBe(false);
    // price should have had a conflict (349 vs 329)
    expect(entity.fieldProvenance.price.hadConflict).toBe(true);
    // entityId should be a UUID
    expect(entity.entityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns empty for empty extractions', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Name', type: 'string', required: true },
    ]);

    const result = await reconciler.reconcile([], schema, defaultConfig, 'Some job');

    expect(result.entities).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it('ignores extractions with no meaningful field values', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Name', type: 'string', required: true },
    ]);

    const result = await reconciler.reconcile(
      [makeExtraction({}), makeExtraction({ name: '', price: null })],
      schema,
      defaultConfig,
      'Some job',
    );

    expect(result.entities).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it('generates match_entities and resolve_conflict actions', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      {
        name: 'product_name',
        description: 'Product name',
        type: 'string',
        required: true,
      },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    const ext1 = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'Sony XM5', price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    const actionTypes = result.actions.map((a) => a.type);
    expect(actionTypes).toContain('match_entities');
    expect(actionTypes).toContain('resolve_conflict');

    // Verify match_entities action content
    const matchAction = result.actions.find(
      (a) => a.type === 'match_entities',
    ) as PipelineAction & {
      type: 'match_entities';
    };
    expect(matchAction.payload.extractionIds).toHaveLength(2);
    expect(matchAction.source).toBe('reconciliation');

    // Verify resolve_conflict action content
    const conflictAction = result.actions.find(
      (a) => a.type === 'resolve_conflict',
    ) as PipelineAction & { type: 'resolve_conflict' };
    expect(conflictAction.payload.fieldName).toBe('price');
    expect(conflictAction.payload.allValues).toHaveLength(2);
    expect(conflictAction.source).toBe('reconciliation');
  });

  it('handles single extraction — returns 1 entity with 1 source, no conflicts', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'product_name', description: 'Product name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    const ext = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0];
    expect(entity.sourceExtractions).toHaveLength(1);
    expect(entity.mergedData.product_name).toBe('Sony XM5');
    expect(entity.mergedData.price).toBe(349);
    // No conflicts for single extraction
    expect(entity.fieldProvenance.product_name.hadConflict).toBe(false);
    expect(entity.fieldProvenance.price.hadConflict).toBe(false);

    // No resolve_conflict actions expected
    const conflictActions = result.actions.filter((a) => a.type === 'resolve_conflict');
    expect(conflictActions).toHaveLength(0);
  });

  it('normalizes values before matching', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      {
        name: 'product_name',
        description: 'Product name',
        type: 'string',
        required: true,
        normalization: {
          type: 'text',
          config: { casing: 'title', trim: true, collapseWhitespace: true },
        },
      },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    // One extraction has messy text, the other is clean
    const ext1 = makeExtraction(
      { product_name: '  sony   xm5  ', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'Sony Xm5', price: 349 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    // After normalization, both become "Sony Xm5" so they should match as 1 entity
    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0];
    expect(entity.sourceExtractions).toHaveLength(2);
    expect(entity.mergedData.product_name).toBe('Sony Xm5');
    // price should agree (no conflict)
    expect(entity.fieldProvenance.price.hadConflict).toBe(false);
  });

  it('uses configured match strategy — exact_name vs composite_key', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'product_name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    // Exact name: both required fields must match exactly
    // Here product_name matches but brand differs
    const ext1 = makeExtraction(
      { product_name: 'XM5', brand: 'Sony', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'XM5', brand: 'SONY', price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    // With exact_name, both required fields form the key.
    // "Sony" lowercased = "sony", "SONY" lowercased = "sony" => they match
    const exactResult = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      { ...defaultConfig, matchStrategy: 'exact_name' },
      'Collect headphone data',
    );
    expect(exactResult.entities).toHaveLength(1);

    // Now test with composite_key at threshold 1.0 — same behavior for exact match
    extractionCounter = 0;
    const ext3 = makeExtraction(
      { product_name: 'XM5', brand: 'Sony', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext4 = makeExtraction(
      { product_name: 'XM5', brand: null, price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    // With composite_key at threshold 0.5: product_name matches, brand is null (one-sided)
    // 1 comparable (product_name), 1 matching => 1/1 = 1.0 >= 0.5 => they match
    // Wait, brand: null in one means brand comparable in composite_key is only if at least one has it.
    // ext3 brand=Sony, ext4 brand=null. comparable=2 (product_name + brand), matching=1 (product_name).
    // ratio = 1/2 = 0.5 >= 0.5 => they match
    const compositeResult = await reconciler.reconcile(
      [ext3, ext4],
      schema,
      { ...defaultConfig, matchStrategy: 'composite_key', fuzzyMatchThreshold: 0.5 },
      'Collect headphone data',
    );
    expect(compositeResult.entities).toHaveLength(1);

    // With exact_name, ext4 has null brand => gets unique key => 2 entities
    extractionCounter = 0;
    const ext5 = makeExtraction(
      { product_name: 'XM5', brand: 'Sony', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext6 = makeExtraction(
      { product_name: 'XM5', brand: null, price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const exactWithNullResult = await reconciler.reconcile(
      [ext5, ext6],
      schema,
      { ...defaultConfig, matchStrategy: 'exact_name' },
      'Collect headphone data',
    );
    // exact_name: null brand => unique key => 2 entities
    expect(exactWithNullResult.entities).toHaveLength(2);
  });

  it('records provenance for normalized fields', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      {
        name: 'product_name',
        description: 'Product name',
        type: 'string',
        required: true,
        normalization: { type: 'text', config: { casing: 'title', trim: true } },
      },
    ]);

    const ext = makeExtraction(
      { product_name: '  sony xm5  ' },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    expect(result.entities).toHaveLength(1);
    const prov = result.entities[0].fieldProvenance.product_name;
    // Value was normalized, so provenance type should be 'normalized'
    expect(prov.provenanceType).toBe('normalized');
    expect(prov.finalValue).toBe('Sony Xm5');
    // Source should record both raw and normalized values
    expect(prov.sources[0].rawValue).toBe('  sony xm5  ');
    expect(prov.sources[0].normalizedValue).toBe('Sony Xm5');
  });

  it('marks merged provenance when multiple sources agree', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'product_name', description: 'Product name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    // Both extractions have the same price — no normalization, no conflict, 2 sources
    const ext1 = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    expect(result.entities).toHaveLength(1);
    // product_name: 2 sources agree, no normalization → 'merged'
    expect(result.entities[0].fieldProvenance.product_name.provenanceType).toBe('merged');
    // price: 2 sources agree, no normalization → 'merged'
    expect(result.entities[0].fieldProvenance.price.provenanceType).toBe('merged');
    expect(result.entities[0].fieldProvenance.price.hadConflict).toBe(false);
  });

  it('marks resolved fields with provenance type resolved', async () => {
    const client = createMockClient();
    const reconciler = new DataReconcilerImpl(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'product_name', description: 'Product name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ]);

    const ext1 = makeExtraction(
      { product_name: 'Sony XM5', price: 349 },
      { sourceDomain: 'amazon.com', sourceUrl: 'https://amazon.com/p1' },
    );
    const ext2 = makeExtraction(
      { product_name: 'Sony XM5', price: 329 },
      { sourceDomain: 'bestbuy.com', sourceUrl: 'https://bestbuy.com/p1' },
    );

    const result = await reconciler.reconcile(
      [ext1, ext2],
      schema,
      defaultConfig,
      'Collect headphone data',
    );

    const priceProv = result.entities[0].fieldProvenance.price;
    expect(priceProv.hadConflict).toBe(true);
    expect(priceProv.provenanceType).toBe('resolved');
    expect(priceProv.resolution).toBeDefined();
  });
});
