import { describe, it, expect } from 'vitest';
import {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  normalizeKeyValue,
} from '../../../src/reconciliation/entity-matcher.js';
import type { ExtractionWithSource } from '../../../src/reconciliation/entity-matcher.js';

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeExtraction(
  id: string,
  data: Record<string, unknown>,
  sourceUrl: string,
): ExtractionWithSource {
  return {
    id,
    jobId: '00000000-0000-0000-0000-000000000001',
    pageId: `page-${id}`,
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
    expect(groups[0].map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('each unique value combination forms its own group', () => {
    const a = makeExtraction('a', { name: 'Widget', sku: '123' }, 'https://shop1.com/a');
    const b = makeExtraction('b', { name: 'Gadget', sku: '456' }, 'https://shop2.com/b');
    const c = makeExtraction('c', { name: 'Widget', sku: '123' }, 'https://shop3.com/c');

    const groups = matchEntitiesExact([a, b, c], ['name', 'sku']);

    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((e) => e.id).sort());
    expect(ids).toContainEqual(['a', 'c']);
    expect(ids).toContainEqual(['b']);
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
    expect(ids).toContainEqual(['a', 'c']);
    expect(ids).toContainEqual(['b']);
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
    expect(ids).toContainEqual(['a', 'b']);
    expect(ids).toContainEqual(['c']);
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
    expect(ids1).toContainEqual(['a', 'b']);
    expect(ids1).toContainEqual(['c']);

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
