import { describe, it, expect, vi } from 'vitest';
import {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  matchEntitiesFuzzy,
  matchEntitiesLLM,
  normalizeKeyValue,
  levenshteinSimilarity,
} from '../../../src/reconciliation/entity-matcher.js';
import type { ExtractionWithSource } from '../../../src/reconciliation/entity-matcher.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeExtraction(
  id: string,
  data: Record<string, unknown>,
  sourceUrl: string,
): ExtractionWithSource {
  return {
    id: `00000000-0000-0000-0000-${id.padStart(12, '0')}`,
    jobId: '00000000-0000-0000-0000-000000000001',
    pageId: `00000000-0000-0000-0001-${id.padStart(12, '0')}`,
    schemaVersion: 1,
    data,
    metadata: {
      confidence: 0.9,
      modelUsed: 'test',
      tokensUsed: 100,
      extractionTimeMs: 50,
      unmappedFields: [],
    },
    sourceUrl,
    sourceDomain: new URL(sourceUrl).hostname,
    crawledAt: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// normalizeKeyValue
// ---------------------------------------------------------------------------

describe('normalizeKeyValue', () => {
  it('lowercases and trims strings', () => {
    expect(normalizeKeyValue('  Hello World  ')).toBe('hello world');
  });

  it('converts numbers to string', () => {
    expect(normalizeKeyValue(42)).toBe('42');
  });

  it('returns empty string for null', () => {
    expect(normalizeKeyValue(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeKeyValue(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// matchEntitiesExact
// ---------------------------------------------------------------------------

describe('matchEntitiesExact', () => {
  it('groups extractions with identical key values', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget', sku: '123' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Widget', sku: '123' }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['name', 'sku']);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    expect(groups[0].map((e) => e.id).sort()).toEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000b',
      '00000000-0000-0000-0000-00000000000c',
    ]);
  });

  it('each unique value combination forms its own group', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Gadget', sku: '456' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Widget', sku: '123' }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['name', 'sku']);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000c',
    ]);
    expect(ids).toContainEqual(['00000000-0000-0000-0000-00000000000b']);
  });

  it('performs case-insensitive matching for strings', () => {
    const a = makeExtraction('a', { name: 'Widget' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'WIDGET' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'widget' }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['name']);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('handles multiple key fields', () => {
    const a = makeExtraction('a', { brand: 'Acme', model: 'X1' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { brand: 'Acme', model: 'X2' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { brand: 'Acme', model: 'X1' }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['brand', 'model']);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000c',
    ]);
    expect(ids).toContainEqual(['00000000-0000-0000-0000-00000000000b']);
  });

  it('missing key fields produce separate groups', () => {
    const a = makeExtraction('a', { name: 'Widget' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget', sku: '123' }, 'https://shop2.com/b');
    const c = makeExtraction('c', {}, 'https://shop3.com/c');

    // a is missing 'sku', c is missing both — each goes to its own group
    const groups = matchEntitiesExact([a, b, c], ['name', 'sku']);

    // a has name but missing sku → own group, b has both → own group, c missing both → own group
    expect(groups).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    const groups = matchEntitiesExact([], ['name']);
    expect(groups).toEqual([]);
  });

  it('numeric key values match correctly', () => {
    const a = makeExtraction('a', { price: 100 }, 'https://shop1.com/a');
    const b = makeExtraction('b', { price: 100 }, 'https://shop2.com/b');
    const c = makeExtraction('c', { price: 200 }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['price']);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000b',
    ]);
    expect(ids).toContainEqual(['00000000-0000-0000-0000-00000000000c']);
  });
});

// ---------------------------------------------------------------------------
// matchEntitiesCompositeKey
// ---------------------------------------------------------------------------

describe('matchEntitiesCompositeKey', () => {
  it('matches with partial overlap above threshold', () => {
    const a = makeExtraction(
      'a',
      { name: 'Widget', sku: '123', brand: 'Acme' },
      'https://shop1.com/a',
    );
    const b = makeExtraction(
      'b',
      { name: 'Widget', sku: '123', brand: 'ACME Inc' },
      'https://shop2.com/b',
    );

    // 2 out of 3 comparable keys match (name, sku match; brand doesn't) → 0.67
    const groups = matchEntitiesCompositeKey([a, b], ['name', 'sku', 'brand'], 0.6);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('does not match below threshold', () => {
    const a = makeExtraction(
      'a',
      { name: 'Widget', sku: '123', brand: 'Acme' },
      'https://shop1.com/a',
    );
    const b = makeExtraction(
      'b',
      { name: 'Gadget', sku: '456', brand: 'Acme' },
      'https://shop2.com/b',
    );

    // 1 out of 3 comparable keys match (brand) → 0.33
    const groups = matchEntitiesCompositeKey([a, b], ['name', 'sku', 'brand'], 0.5);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
  });

  it('handles empty key fields — both empty means not comparable', () => {
    const a = makeExtraction('a', { name: 'Widget' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget' }, 'https://shop2.com/b');

    // name is comparable and matches. sku is empty on both → not comparable.
    // 1/1 comparable = 1.0
    const groups = matchEntitiesCompositeKey([a, b], ['name', 'sku'], 0.5);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('transitive matching via union-find (A↔B, B↔C → all grouped)', () => {
    const a = makeExtraction(
      'a',
      { name: 'Widget', sku: '123', color: 'red' },
      'https://shop1.com/a',
    );
    const b = makeExtraction(
      'b',
      { name: 'Widget', sku: '456', color: 'red' },
      'https://shop2.com/b',
    );
    const c = makeExtraction(
      'c',
      { name: 'Gadget', sku: '456', color: 'blue' },
      'https://shop3.com/c',
    );

    // A↔B: name matches, sku doesn't, color matches → 2/3 = 0.67 ≥ 0.6 ✓
    // B↔C: name doesn't, sku matches, color doesn't → 1/3 = 0.33 < 0.6 ✗
    // A↔C: name doesn't, sku doesn't, color doesn't → 0/3 = 0.0 < 0.6 ✗
    // Only A and B are grouped, C is separate.
    const groups1 = matchEntitiesCompositeKey([a, b, c], ['name', 'sku', 'color'], 0.6);
    expect(groups1).toHaveLength(2);
    const ids1 = groups1.map((g) => g.map((e) => e.id).sort());
    expect(ids1).toContainEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000b',
    ]);
    expect(ids1).toContainEqual(['00000000-0000-0000-0000-00000000000c']);

    // Now adjust so B↔C also matches with a lower threshold → transitive grouping
    // A↔B: 2/3 = 0.67 ≥ 0.3 ✓
    // B↔C: 1/3 = 0.33 ≥ 0.3 ✓
    // A↔C: 0/3 = 0.0 < 0.3 ✗, but via union-find: A↔B and B↔C → A,B,C all grouped
    const groups2 = matchEntitiesCompositeKey([a, b, c], ['name', 'sku', 'color'], 0.3);
    expect(groups2).toHaveLength(1);
    expect(groups2[0]).toHaveLength(3);
  });

  it('one-sided empty key counts as comparable but non-matching', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget' }, 'https://shop2.com/b');

    // name: comparable, matches → 1 match
    // sku: a has '123', b has nothing → comparable, doesn't match
    // ratio = 1/2 = 0.5
    const groups = matchEntitiesCompositeKey([a, b], ['name', 'sku'], 0.6);

    expect(groups).toHaveLength(2); // below threshold
  });

  it('returns empty array for empty input', () => {
    const groups = matchEntitiesCompositeKey([], ['name'], 0.5);
    expect(groups).toEqual([]);
  });

  it('single extraction returns a single group', () => {
    const a = makeExtraction('a', { name: 'Widget' }, 'https://shop1.com/a');
    const groups = matchEntitiesCompositeKey([a], ['name'], 0.5);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  it('all extractions match forms one group', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'widget', sku: '123' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'WIDGET', sku: '123' }, 'https://shop3.com/c');

    const groups = matchEntitiesCompositeKey([a, b, c], ['name', 'sku'], 0.5);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('no comparable keys means no match', () => {
    const a = makeExtraction('a', {}, 'https://shop1.com/a');
    const b = makeExtraction('b', {}, 'https://shop2.com/b');

    // No comparable keys → ratio is 0, below any threshold
    const groups = matchEntitiesCompositeKey([a, b], ['name', 'sku'], 0.5);

    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// LLM mock helper
// ---------------------------------------------------------------------------

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    }),
  };
}

// ---------------------------------------------------------------------------
// levenshteinSimilarity
// ---------------------------------------------------------------------------

describe('levenshteinSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for completely different strings of equal length', () => {
    expect(levenshteinSimilarity('abc', 'xyz')).toBe(0);
  });

  it('returns high similarity for similar strings', () => {
    // "kitten" vs "sitten" → distance 1, max length 6 → 1 - 1/6 ≈ 0.833
    const sim = levenshteinSimilarity('kitten', 'sitten');
    expect(sim).toBeGreaterThan(0.8);
    expect(sim).toBeLessThan(0.9);
  });

  it('is case-insensitive', () => {
    expect(levenshteinSimilarity('Hello', 'hello')).toBe(1);
    expect(levenshteinSimilarity('ABC', 'abc')).toBe(1);
  });

  it('returns 1 for both empty strings', () => {
    expect(levenshteinSimilarity('', '')).toBe(1);
  });

  it('returns 0 when one string is empty and the other is not', () => {
    expect(levenshteinSimilarity('', 'hello')).toBe(0);
    expect(levenshteinSimilarity('world', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchEntitiesFuzzy
// ---------------------------------------------------------------------------

describe('matchEntitiesFuzzy', () => {
  it('groups similar names above threshold', () => {
    const a = makeExtraction('a', { name: 'iPhone 15 Pro' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'iPhone 15 pro' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Samsung Galaxy S24' }, 'https://shop3.com/c');

    const groups = matchEntitiesFuzzy([a, b, c], ['name'], 0.8);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000b',
    ]);
    expect(ids).toContainEqual(['00000000-0000-0000-0000-00000000000c']);
  });

  it('keeps dissimilar extractions separate', () => {
    const a = makeExtraction('a', { name: 'Apple' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Orange' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Banana' }, 'https://shop3.com/c');

    const groups = matchEntitiesFuzzy([a, b, c], ['name'], 0.8);

    expect(groups).toHaveLength(3);
  });

  it('handles one-sided empty fields — counts as comparable with 0 similarity', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget' }, 'https://shop2.com/b');

    // name: similarity 1.0, sku: one-sided empty → comparable with 0 similarity
    // average = (1.0 + 0) / 2 = 0.5
    const groups = matchEntitiesFuzzy([a, b], ['name', 'sku'], 0.6);

    expect(groups).toHaveLength(2); // below threshold → separate
  });

  it('skips fields where both values are empty', () => {
    const a = makeExtraction('a', { name: 'Widget' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widgett' }, 'https://shop2.com/b');

    // name: similar. sku: both empty → skipped.
    // Only 1 comparable field: name similarity ≈ 0.857
    const groups = matchEntitiesFuzzy([a, b], ['name', 'sku'], 0.8);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    const groups = matchEntitiesFuzzy([], ['name'], 0.8);
    expect(groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchEntitiesLLM
// ---------------------------------------------------------------------------

describe('matchEntitiesLLM', () => {
  const defaultLLMConfig = {
    primaryModel: 'anthropic/claude-sonnet-4-20250514',
  };

  it('groups based on LLM response', async () => {
    const a = makeExtraction('a', { name: 'Widget A' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget B' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Gadget C' }, 'https://shop3.com/c');

    const llmResponse = JSON.stringify({
      groups: [
        {
          extractionIds: [a.id, b.id],
          reasoning: 'Both are widgets from different shops',
          confidence: 0.9,
        },
        {
          extractionIds: [c.id],
          reasoning: 'Gadget is a different product',
          confidence: 0.95,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const groups = await matchEntitiesLLM([a, b, c], client, defaultLLMConfig);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([a.id, b.id].sort());
    expect(ids).toContainEqual([c.id]);
  });

  it('falls back to singletons on LLM error', async () => {
    const a = makeExtraction('a', { name: 'Widget A' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget B' }, 'https://shop2.com/b');

    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
    };

    const groups = await matchEntitiesLLM([a, b], client, defaultLLMConfig);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
  });

  it('falls back to singletons on invalid JSON', async () => {
    const a = makeExtraction('a', { name: 'Widget A' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget B' }, 'https://shop2.com/b');

    const client = createMockClient('not valid json at all');
    const groups = await matchEntitiesLLM([a, b], client, defaultLLMConfig);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
  });

  it('handles extractions not covered by LLM response — puts them in singleton groups', async () => {
    const a = makeExtraction('a', { name: 'Widget A' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Widget B' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Gadget C' }, 'https://shop3.com/c');

    // LLM only groups a and b, ignores c
    const llmResponse = JSON.stringify({
      groups: [
        {
          extractionIds: [a.id, b.id],
          reasoning: 'Both widgets',
          confidence: 0.9,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const groups = await matchEntitiesLLM([a, b, c], client, defaultLLMConfig);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual([a.id, b.id].sort());
    expect(ids).toContainEqual([c.id]);
  });

  it('falls back to singletons when LLM returns invalid schema', async () => {
    const a = makeExtraction('a', { name: 'Widget A' }, 'https://shop1.com/a');

    // Valid JSON but doesn't match the expected Zod schema
    const client = createMockClient(JSON.stringify({ wrongField: true }));
    const groups = await matchEntitiesLLM([a], client, defaultLLMConfig);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0][0].id).toBe(a.id);
  });
});
