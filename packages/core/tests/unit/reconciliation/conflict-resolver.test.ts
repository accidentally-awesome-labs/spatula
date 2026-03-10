import { describe, it, expect } from 'vitest';
import {
  resolveConflict,
  type FieldConflict,
  type FieldConflictValue,
  type ResolvedField,
  type ConflictResolverOptions,
} from '../../../src/reconciliation/conflict-resolver.js';
import type { SourceTrust } from '../../../src/types/reconciliation.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeValue(
  source: string,
  value: unknown,
  extractionId: string,
  crawledAt: Date | string = '2026-01-15',
): FieldConflictValue {
  return {
    source,
    value,
    extractionId,
    crawledAt: typeof crawledAt === 'string' ? new Date(crawledAt) : crawledAt,
  };
}

function makeConflict(fieldName: string, values: FieldConflictValue[]): FieldConflict {
  return { fieldName, values };
}

// ---------------------------------------------------------------------------
// Single value — no conflict
// ---------------------------------------------------------------------------

describe('resolveConflict — single value', () => {
  it('returns the only value with hadConflict = false', () => {
    const conflict = makeConflict('price', [makeValue('amazon.com', 29.99, 'ext-1')]);

    const result = resolveConflict(conflict, 'most_common');

    expect(result.fieldName).toBe('price');
    expect(result.resolvedValue).toBe(29.99);
    expect(result.sourcePreferred).toBe('amazon.com');
    expect(result.hadConflict).toBe(false);
    expect(result.resolution).toBe('most_common');
  });
});

// ---------------------------------------------------------------------------
// All same value — no conflict
// ---------------------------------------------------------------------------

describe('resolveConflict — all same value', () => {
  it('returns first value with hadConflict = false when all values match', () => {
    const conflict = makeConflict('name', [
      makeValue('amazon.com', 'Widget Pro', 'ext-1'),
      makeValue('bestbuy.com', 'Widget Pro', 'ext-2'),
      makeValue('walmart.com', 'Widget Pro', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'most_recent');

    expect(result.resolvedValue).toBe('Widget Pro');
    expect(result.sourcePreferred).toBe('amazon.com');
    expect(result.hadConflict).toBe(false);
  });

  it('detects identical objects as same value', () => {
    const conflict = makeConflict('dimensions', [
      makeValue('a.com', { width: 10, height: 20 }, 'ext-1'),
      makeValue('b.com', { width: 10, height: 20 }, 'ext-2'),
    ]);

    const result = resolveConflict(conflict, 'most_common');

    expect(result.hadConflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// most_common
// ---------------------------------------------------------------------------

describe('resolveConflict — most_common', () => {
  it('picks the most frequent value', () => {
    const conflict = makeConflict('color', [
      makeValue('a.com', 'blue', 'ext-1'),
      makeValue('b.com', 'red', 'ext-2'),
      makeValue('c.com', 'blue', 'ext-3'),
      makeValue('d.com', 'red', 'ext-4'),
      makeValue('e.com', 'blue', 'ext-5'),
    ]);

    const result = resolveConflict(conflict, 'most_common');

    expect(result.resolvedValue).toBe('blue');
    expect(result.hadConflict).toBe(true);
    expect(result.resolution).toBe('most_common');
  });

  it('on tie picks the first encountered value', () => {
    const conflict = makeConflict('rating', [
      makeValue('a.com', 4.5, 'ext-1'),
      makeValue('b.com', 4.0, 'ext-2'),
      makeValue('c.com', 4.5, 'ext-3'),
      makeValue('d.com', 4.0, 'ext-4'),
    ]);

    const result = resolveConflict(conflict, 'most_common');

    // 4.5 and 4.0 both appear twice; 4.5 was encountered first
    expect(result.resolvedValue).toBe(4.5);
    expect(result.sourcePreferred).toBe('a.com');
  });
});

// ---------------------------------------------------------------------------
// most_recent
// ---------------------------------------------------------------------------

describe('resolveConflict — most_recent', () => {
  it('picks the value with the latest crawledAt date', () => {
    const conflict = makeConflict('price', [
      makeValue('a.com', 19.99, 'ext-1', '2026-01-10'),
      makeValue('b.com', 24.99, 'ext-2', '2026-02-15'),
      makeValue('c.com', 21.99, 'ext-3', '2026-01-20'),
    ]);

    const result = resolveConflict(conflict, 'most_recent');

    expect(result.resolvedValue).toBe(24.99);
    expect(result.sourcePreferred).toBe('b.com');
    expect(result.hadConflict).toBe(true);
    expect(result.resolution).toBe('most_recent');
  });
});

// ---------------------------------------------------------------------------
// source_priority
// ---------------------------------------------------------------------------

describe('resolveConflict — source_priority', () => {
  const trustRankings: SourceTrust[] = [
    { domain: 'official.com', trustLevel: 'authoritative', reasoning: 'Official source' },
    { domain: 'trusted.com', trustLevel: 'high', reasoning: 'Reputable retailer' },
    { domain: 'blog.com', trustLevel: 'low', reasoning: 'User blog' },
    { domain: 'mid.com', trustLevel: 'medium', reasoning: 'Secondary source' },
  ];

  it('picks the value from the highest trust source', () => {
    const conflict = makeConflict('weight', [
      makeValue('blog.com', '5 lbs', 'ext-1'),
      makeValue('official.com', '4.8 lbs', 'ext-2'),
      makeValue('trusted.com', '5.0 lbs', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'source_priority', { trustRankings });

    expect(result.resolvedValue).toBe('4.8 lbs');
    expect(result.sourcePreferred).toBe('official.com');
    expect(result.hadConflict).toBe(true);
    expect(result.resolution).toBe('source_priority');
  });

  it('among same trust level, picks the first encountered', () => {
    const rankings: SourceTrust[] = [
      { domain: 'a.com', trustLevel: 'high', reasoning: 'Source A' },
      { domain: 'b.com', trustLevel: 'high', reasoning: 'Source B' },
    ];

    const conflict = makeConflict('brand', [
      makeValue('a.com', 'BrandA', 'ext-1'),
      makeValue('b.com', 'BrandB', 'ext-2'),
    ]);

    const result = resolveConflict(conflict, 'source_priority', { trustRankings: rankings });

    expect(result.resolvedValue).toBe('BrandA');
    expect(result.sourcePreferred).toBe('a.com');
  });

  it('falls back to most_common when no trustRankings provided', () => {
    const conflict = makeConflict('color', [
      makeValue('a.com', 'green', 'ext-1'),
      makeValue('b.com', 'blue', 'ext-2'),
      makeValue('c.com', 'green', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'source_priority');

    // Falls back to most_common → green appears twice
    expect(result.resolvedValue).toBe('green');
    expect(result.resolution).toBe('source_priority');
  });
});

// ---------------------------------------------------------------------------
// most_complete
// ---------------------------------------------------------------------------

describe('resolveConflict — most_complete', () => {
  it('picks the value with the longest JSON representation', () => {
    const conflict = makeConflict('description', [
      makeValue('a.com', 'Short desc', 'ext-1'),
      makeValue(
        'b.com',
        'A much more detailed and complete product description with extra info',
        'ext-2',
      ),
      makeValue('c.com', 'Medium description text', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'most_complete');

    expect(result.resolvedValue).toBe(
      'A much more detailed and complete product description with extra info',
    );
    expect(result.sourcePreferred).toBe('b.com');
    expect(result.hadConflict).toBe(true);
    expect(result.resolution).toBe('most_complete');
  });

  it('picks the more detailed object over a simpler one', () => {
    const conflict = makeConflict('specs', [
      makeValue('a.com', { weight: '5 lbs' }, 'ext-1'),
      makeValue(
        'b.com',
        { weight: '5 lbs', height: '10 in', width: '6 in', depth: '3 in' },
        'ext-2',
      ),
    ]);

    const result = resolveConflict(conflict, 'most_complete');

    expect(result.resolvedValue).toEqual({
      weight: '5 lbs',
      height: '10 in',
      width: '6 in',
      depth: '3 in',
    });
    expect(result.sourcePreferred).toBe('b.com');
  });
});

// ---------------------------------------------------------------------------
// llm_resolved
// ---------------------------------------------------------------------------

describe('resolveConflict — llm_resolved', () => {
  it('falls back to most_common behavior', () => {
    const conflict = makeConflict('category', [
      makeValue('a.com', 'Electronics', 'ext-1'),
      makeValue('b.com', 'Gadgets', 'ext-2'),
      makeValue('c.com', 'Electronics', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'llm_resolved');

    expect(result.resolvedValue).toBe('Electronics');
    expect(result.resolution).toBe('llm_resolved');
    expect(result.hadConflict).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Null / undefined values
// ---------------------------------------------------------------------------

describe('resolveConflict — null and undefined handling', () => {
  it('handles null values among other values', () => {
    const conflict = makeConflict('sku', [
      makeValue('a.com', null, 'ext-1'),
      makeValue('b.com', 'SKU-123', 'ext-2'),
      makeValue('c.com', null, 'ext-3'),
    ]);

    // most_common: null appears twice
    const result = resolveConflict(conflict, 'most_common');
    expect(result.resolvedValue).toBeNull();
    expect(result.hadConflict).toBe(true);
  });

  it('handles undefined values', () => {
    const conflict = makeConflict('optional_field', [
      makeValue('a.com', undefined, 'ext-1'),
      makeValue('b.com', 'value', 'ext-2'),
    ]);

    // most_complete: 'value' is longer than undefined
    const result = resolveConflict(conflict, 'most_complete');
    expect(result.resolvedValue).toBe('value');
  });
});

// ---------------------------------------------------------------------------
// Various data types
// ---------------------------------------------------------------------------

describe('resolveConflict — various data types', () => {
  it('works with number values', () => {
    const conflict = makeConflict('quantity', [
      makeValue('a.com', 100, 'ext-1'),
      makeValue('b.com', 200, 'ext-2'),
      makeValue('c.com', 100, 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'most_common');
    expect(result.resolvedValue).toBe(100);
  });

  it('works with object values', () => {
    const conflict = makeConflict('address', [
      makeValue('a.com', { city: 'NYC', state: 'NY' }, 'ext-1', '2026-01-01'),
      makeValue('b.com', { city: 'New York', state: 'NY' }, 'ext-2', '2026-02-01'),
    ]);

    const result = resolveConflict(conflict, 'most_recent');
    expect(result.resolvedValue).toEqual({ city: 'New York', state: 'NY' });
    expect(result.sourcePreferred).toBe('b.com');
  });

  it('works with array values', () => {
    const conflict = makeConflict('tags', [
      makeValue('a.com', ['tech', 'gadget'], 'ext-1'),
      makeValue('b.com', ['tech', 'gadget', 'electronics', 'portable'], 'ext-2'),
    ]);

    const result = resolveConflict(conflict, 'most_complete');
    expect(result.resolvedValue).toEqual(['tech', 'gadget', 'electronics', 'portable']);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('resolveConflict — edge cases', () => {
  it('returns early for an empty values array', () => {
    const conflict = makeConflict('empty_field', []);

    const result = resolveConflict(conflict, 'most_common');

    expect(result.fieldName).toBe('empty_field');
    expect(result.resolvedValue).toBeUndefined();
    expect(result.sourcePreferred).toBe('');
    expect(result.hadConflict).toBe(false);
    expect(result.resolution).toBe('most_common');
  });

  it('counts undefined values properly in most_common', () => {
    const conflict = makeConflict('maybe_missing', [
      makeValue('a.com', undefined, 'ext-1'),
      makeValue('b.com', undefined, 'ext-2'),
      makeValue('c.com', 'present', 'ext-3'),
    ]);

    const result = resolveConflict(conflict, 'most_common');

    // undefined appears twice, 'present' once — undefined wins
    expect(result.resolvedValue).toBeUndefined();
    expect(result.hadConflict).toBe(true);
  });

  it('does not treat NaN and null as equal in allSameValue', () => {
    const conflict = makeConflict('tricky', [
      makeValue('a.com', NaN, 'ext-1'),
      makeValue('b.com', null, 'ext-2'),
    ]);

    const result = resolveConflict(conflict, 'most_common');

    // NaN and null are different values — should detect a conflict
    expect(result.hadConflict).toBe(true);
  });

  it('uses typed ConflictResolverOptions', () => {
    const options: ConflictResolverOptions = {
      trustRankings: [
        { domain: 'official.com', trustLevel: 'authoritative', reasoning: 'Official' },
      ],
    };

    const conflict = makeConflict('typed_field', [
      makeValue('official.com', 'official_val', 'ext-1'),
      makeValue('random.com', 'random_val', 'ext-2'),
    ]);

    const result = resolveConflict(conflict, 'source_priority', options);

    expect(result.resolvedValue).toBe('official_val');
    expect(result.sourcePreferred).toBe('official.com');
  });
});
