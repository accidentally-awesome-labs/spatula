# Phase 7: Data Reconciliation & Normalization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three-layer consolidation pipeline that transforms messy multi-source extraction data into clean, unified entities with full provenance trails.

**Architecture:** The reconciliation engine is a pipeline: normalize extraction values → evaluate source trust → match entities → resolve conflicts → fill gaps → build EntityMatch objects with per-field provenance. Each stage is a separate, testable component orchestrated by a `DataReconcilerImpl` class that implements the pre-existing `DataReconciler` interface. A new BullMQ reconciliation worker triggers when a job transitions to the `reconciling` state.

**Tech Stack:** TypeScript, Zod validation, BullMQ, Drizzle ORM, LLM via OpenRouter (entity matching + conflict resolution + gap filling)

---

## Context & Pre-existing Code

**Already defined (Phase 1 types):**

- `NormalizationRule` — 7 discriminated union types in `packages/core/src/types/normalization.ts`
- `EntityMatch`, `FieldProvenanceEntry`, `SourceTrust` — in `packages/core/src/types/reconciliation.ts`
- `ReconciliationConfig`, `EntityMatchStrategy`, `ConflictResolution` — in `packages/core/src/types/job.ts`
- `ValueProvenance` — `'extracted' | 'normalized' | 'merged' | 'resolved' | 'inferred'` in `packages/core/src/types/extraction.ts`
- 6 reconciliation PipelineAction types — `match_entities`, `split_entities`, `resolve_conflict`, `infer_value`, `correct_value`, `set_source_trust` in `packages/core/src/types/actions.ts`
- `DataReconciler` interface — in `packages/core/src/interfaces/reconciler.ts`
- LLM model routing — `resolveModel(config, 'entityMatching' | 'conflictResolution')` in `packages/core/src/llm/model-router.ts`

**Already defined (Phase 4 DB):**

- `entities` table + `entitySources` join table — in `packages/db/src/schema/entities.ts`
- `sourceTrust` table — in `packages/db/src/schema/source-trust.ts`
- DB connection type, repository patterns — `packages/db/src/repositories/`

**Already defined (Phase 5 queue):**

- `JobStateMachine` with `reconciling` state — `packages/queue/src/state-machine.ts`
- `JobManager` — `packages/queue/src/job-manager.ts`
- `WorkerDeps` pattern — `packages/queue/src/worker-deps.ts`

**Phase 6 builds normalization RULES; Phase 7 APPLIES them.**

---

## Task 1: Value Normalizer — Pure Rule Application

Apply `NormalizationRule` objects to extraction data values. This is Layer 2 of the three-layer consolidation pipeline.

**Files:**

- Create: `packages/core/src/reconciliation/value-normalizer.ts`
- Test: `packages/core/tests/unit/reconciliation/value-normalizer.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect } from 'vitest';
import {
  applyNormalizationRule,
  normalizeExtractionData,
} from '../../../src/reconciliation/value-normalizer.js';
import type { NormalizationRule } from '../../../src/types/normalization.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

describe('applyNormalizationRule', () => {
  describe('text normalization', () => {
    const rule: NormalizationRule = {
      type: 'text',
      config: { casing: 'title', trim: true, collapseWhitespace: true },
    };

    it('applies title casing, trim, and whitespace collapse', () => {
      expect(applyNormalizationRule('  hello   world  ', rule)).toBe('Hello World');
    });

    it('handles lower casing', () => {
      const lowerRule: NormalizationRule = {
        type: 'text',
        config: { casing: 'lower', trim: true, collapseWhitespace: true },
      };
      expect(applyNormalizationRule('HELLO World', lowerRule)).toBe('hello world');
    });

    it('handles upper casing', () => {
      const upperRule: NormalizationRule = {
        type: 'text',
        config: { casing: 'upper', trim: true, collapseWhitespace: true },
      };
      expect(applyNormalizationRule('hello world', upperRule)).toBe('HELLO WORLD');
    });

    it('preserves casing when set to preserve', () => {
      const preserveRule: NormalizationRule = {
        type: 'text',
        config: { casing: 'preserve', trim: true, collapseWhitespace: false },
      };
      expect(applyNormalizationRule('  Hello   World  ', preserveRule)).toBe('Hello   World');
    });

    it('returns non-string values unchanged', () => {
      expect(applyNormalizationRule(42, rule)).toBe(42);
      expect(applyNormalizationRule(null, rule)).toBeNull();
    });
  });

  describe('enum normalization', () => {
    const rule: NormalizationRule = {
      type: 'enum',
      config: {
        canonicalValues: ['Black', 'Silver', 'Midnight'],
        synonymMap: { black: 'Black', MIDNIGHT: 'Midnight', silver: 'Silver' },
      },
    };

    it('maps synonym to canonical value', () => {
      expect(applyNormalizationRule('black', rule)).toBe('Black');
      expect(applyNormalizationRule('MIDNIGHT', rule)).toBe('Midnight');
    });

    it('returns canonical value unchanged', () => {
      expect(applyNormalizationRule('Black', rule)).toBe('Black');
    });

    it('returns unknown value unchanged', () => {
      expect(applyNormalizationRule('Red', rule)).toBe('Red');
    });
  });

  describe('currency normalization', () => {
    const rule: NormalizationRule = {
      type: 'currency',
      config: { targetCurrency: 'USD', decimalPlaces: 2 },
    };

    it('strips $ prefix and converts to number', () => {
      expect(applyNormalizationRule('$379.99', rule)).toBe(379.99);
    });

    it('strips currency suffix', () => {
      expect(applyNormalizationRule('329.00 USD', rule)).toBe(329.0);
    });

    it('parses plain number string', () => {
      expect(applyNormalizationRule('549', rule)).toBe(549.0);
    });

    it('rounds to configured decimal places', () => {
      expect(applyNormalizationRule('$99.999', rule)).toBe(100.0);
    });

    it('returns already-numeric values rounded', () => {
      expect(applyNormalizationRule(379.994, rule)).toBe(379.99);
    });
  });

  describe('boolean normalization', () => {
    const rule: NormalizationRule = {
      type: 'boolean',
      config: {
        trueValues: ['yes', 'true', '1', 'available'],
        falseValues: ['no', 'false', '0', 'unavailable'],
      },
    };

    it('maps truthy strings to true', () => {
      expect(applyNormalizationRule('yes', rule)).toBe(true);
      expect(applyNormalizationRule('TRUE', rule)).toBe(true);
      expect(applyNormalizationRule('Available', rule)).toBe(true);
    });

    it('maps falsy strings to false', () => {
      expect(applyNormalizationRule('no', rule)).toBe(false);
      expect(applyNormalizationRule('0', rule)).toBe(false);
    });

    it('returns non-matching values unchanged', () => {
      expect(applyNormalizationRule('maybe', rule)).toBe('maybe');
    });
  });

  describe('list normalization', () => {
    const rule: NormalizationRule = {
      type: 'list',
      config: { separator: ',' },
    };

    it('splits comma-separated string into array', () => {
      expect(applyNormalizationRule('a, b, c', rule)).toEqual(['a', 'b', 'c']);
    });

    it('returns existing arrays unchanged', () => {
      expect(applyNormalizationRule(['a', 'b'], rule)).toEqual(['a', 'b']);
    });

    it('handles custom separator', () => {
      const pipeRule: NormalizationRule = { type: 'list', config: { separator: '|' } };
      expect(applyNormalizationRule('x|y|z', pipeRule)).toEqual(['x', 'y', 'z']);
    });
  });

  describe('measurement normalization', () => {
    const rule: NormalizationRule = {
      type: 'measurement',
      config: { targetUnit: 'g', format: 'value_unit' },
    };

    it('extracts numeric value from measurement string', () => {
      const result = applyNormalizationRule('250g', rule);
      expect(result).toBe(250);
    });

    it('converts kg to g', () => {
      const result = applyNormalizationRule('1.5 kg', rule);
      expect(result).toBe(1500);
    });

    it('returns non-string values unchanged', () => {
      expect(applyNormalizationRule(250, rule)).toBe(250);
    });
  });
});

describe('normalizeExtractionData', () => {
  const schema: SchemaDefinition = {
    version: 1,
    fields: [
      {
        name: 'product_name',
        description: 'Name',
        type: 'string',
        required: true,
        normalization: {
          type: 'text',
          config: { casing: 'title', trim: true, collapseWhitespace: true },
        },
      },
      {
        name: 'price',
        description: 'Price',
        type: 'currency',
        required: true,
        normalization: { type: 'currency', config: { targetCurrency: 'USD', decimalPlaces: 2 } },
      },
      {
        name: 'color',
        description: 'Color',
        type: 'enum',
        required: false,
        // No normalization rule — should be left alone
      },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };

  it('normalizes fields that have rules, skips those without', () => {
    const data = { product_name: '  sony xm5  ', price: '$379.99', color: 'black' };
    const result = normalizeExtractionData(data, schema);

    expect(result.normalizedData.product_name).toBe('Sony Xm5');
    expect(result.normalizedData.price).toBe(379.99);
    expect(result.normalizedData.color).toBe('black'); // untouched
  });

  it('tracks which fields were changed', () => {
    const data = { product_name: '  sony xm5  ', price: '$379.99', color: 'black' };
    const result = normalizeExtractionData(data, schema);

    expect(result.changes).toHaveLength(2);
    expect(result.changes).toContainEqual({
      fieldName: 'product_name',
      before: '  sony xm5  ',
      after: 'Sony Xm5',
    });
  });

  it('does not track unchanged fields', () => {
    const data = { product_name: 'Already Title', price: 100.0 };
    const result = normalizeExtractionData(data, schema);

    // price 100.00 is already normalized, product_name title case matches
    const priceChange = result.changes.find((c) => c.fieldName === 'price');
    expect(priceChange).toBeUndefined();
  });

  it('handles missing fields gracefully', () => {
    const data = { product_name: 'Test' };
    const result = normalizeExtractionData(data, schema);

    expect(result.normalizedData.product_name).toBe('Test');
    expect(result.normalizedData.price).toBeUndefined();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @spatula/core test -- --reporter verbose tests/unit/reconciliation/value-normalizer.test.ts`
Expected: FAIL — module not found

### Step 3: Implement value normalizer

```typescript
// packages/core/src/reconciliation/value-normalizer.ts
import type { NormalizationRule } from '../types/normalization.js';
import type { SchemaDefinition } from '../types/schema.js';

export interface NormalizationChange {
  fieldName: string;
  before: unknown;
  after: unknown;
}

export interface NormalizedResult {
  normalizedData: Record<string, unknown>;
  changes: NormalizationChange[];
}

/**
 * Apply a single normalization rule to a value.
 * Pure function — no side effects, no LLM calls.
 * The 'llm' rule type is a no-op here (requires async LLM call handled separately).
 */
export function applyNormalizationRule(value: unknown, rule: NormalizationRule): unknown {
  if (value === null || value === undefined) return value;

  switch (rule.type) {
    case 'text':
      return normalizeText(value, rule.config);
    case 'enum':
      return normalizeEnum(value, rule.config);
    case 'currency':
      return normalizeCurrency(value, rule.config);
    case 'boolean':
      return normalizeBoolean(value, rule.config);
    case 'list':
      return normalizeList(value, rule.config);
    case 'measurement':
      return normalizeMeasurement(value, rule.config);
    case 'llm':
      // LLM normalization requires async call — handled at pipeline level
      return value;
  }
}

function normalizeText(
  value: unknown,
  config: {
    casing: 'title' | 'lower' | 'upper' | 'preserve';
    trim: boolean;
    collapseWhitespace: boolean;
  },
): unknown {
  if (typeof value !== 'string') return value;

  let result = value;
  if (config.trim) result = result.trim();
  if (config.collapseWhitespace) result = result.replace(/\s+/g, ' ');

  switch (config.casing) {
    case 'lower':
      return result.toLowerCase();
    case 'upper':
      return result.toUpperCase();
    case 'title':
      return result.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    case 'preserve':
      return result;
  }
}

function normalizeEnum(
  value: unknown,
  config: { canonicalValues: string[]; synonymMap: Record<string, string> },
): unknown {
  if (typeof value !== 'string') return value;
  return config.synonymMap[value] ?? value;
}

function normalizeCurrency(
  value: unknown,
  config: { targetCurrency?: string; decimalPlaces: number },
): unknown {
  let numericValue: number;

  if (typeof value === 'number') {
    numericValue = value;
  } else if (typeof value === 'string') {
    // Strip currency symbols, codes, and whitespace
    const cleaned = value.replace(/[^0-9.\-]/g, '');
    numericValue = parseFloat(cleaned);
    if (isNaN(numericValue)) return value;
  } else {
    return value;
  }

  const factor = Math.pow(10, config.decimalPlaces);
  return Math.round(numericValue * factor) / factor;
}

function normalizeBoolean(
  value: unknown,
  config: { trueValues: string[]; falseValues: string[] },
): unknown {
  if (typeof value !== 'string') return value;
  const lower = value.toLowerCase();
  if (config.trueValues.includes(lower)) return true;
  if (config.falseValues.includes(lower)) return false;
  return value;
}

function normalizeList(value: unknown, config: { separator?: string }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;

  const sep = config.separator ?? ',';
  return value.split(sep).map((s) => s.trim());
}

const MEASUREMENT_CONVERSIONS: Record<string, Record<string, number>> = {
  g: { kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 },
  kg: { g: 0.001, mg: 0.000001, oz: 0.0283495, lb: 0.453592 },
  mm: { cm: 10, m: 1000, in: 25.4, ft: 304.8 },
  cm: { mm: 0.1, m: 100, in: 2.54, ft: 30.48 },
};

function normalizeMeasurement(
  value: unknown,
  config: { targetUnit?: string; format?: string },
): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = value.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!match) return value;

  const numericValue = parseFloat(match[1]);
  const sourceUnit = match[2].toLowerCase();
  const targetUnit = config.targetUnit?.toLowerCase();

  if (!targetUnit || sourceUnit === targetUnit) return numericValue;

  const conversions = MEASUREMENT_CONVERSIONS[targetUnit];
  if (conversions && conversions[sourceUnit] !== undefined) {
    return Math.round(numericValue * conversions[sourceUnit] * 1000) / 1000;
  }

  return numericValue;
}

/**
 * Normalize all fields in extraction data according to schema normalization rules.
 * Returns normalized data and a list of field changes for provenance tracking.
 */
export function normalizeExtractionData(
  data: Record<string, unknown>,
  schema: SchemaDefinition,
): NormalizedResult {
  const normalizedData: Record<string, unknown> = { ...data };
  const changes: NormalizationChange[] = [];

  for (const field of schema.fields) {
    if (!field.normalization) continue;
    if (!(field.name in data)) continue;

    const before = data[field.name];
    const after = applyNormalizationRule(before, field.normalization);

    normalizedData[field.name] = after;

    // Only track actual changes
    if (!Object.is(before, after) && JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ fieldName: field.name, before, after });
    }
  }

  return { normalizedData, changes };
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @spatula/core test -- --reporter verbose tests/unit/reconciliation/value-normalizer.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/core/src/reconciliation/value-normalizer.ts packages/core/tests/unit/reconciliation/value-normalizer.test.ts
git commit -m "feat(core): add value normalizer for applying normalization rules to extraction data"
```

---

## Task 2: Entity Matcher — Exact & Composite Key Strategies

Pure matching logic that groups extractions representing the same real-world entity.

**Files:**

- Create: `packages/core/src/reconciliation/entity-matcher.ts`
- Test: `packages/core/tests/unit/reconciliation/entity-matcher.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  type ExtractionWithSource,
} from '../../../src/reconciliation/entity-matcher.js';

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

describe('matchEntitiesExact', () => {
  it('groups extractions with identical key values', () => {
    const extractions = [
      makeExtraction('e1', { product_name: 'Sony XM5', price: 379 }, 'https://amazon.com/p1'),
      makeExtraction('e2', { product_name: 'Sony XM5', price: 329 }, 'https://bestbuy.com/p1'),
      makeExtraction('e3', { product_name: 'Bose QC45', price: 279 }, 'https://amazon.com/p2'),
    ];

    const groups = matchEntitiesExact(extractions, ['product_name']);

    expect(groups).toHaveLength(2);
    const sonyGroup = groups.find((g) => g.length === 2);
    expect(sonyGroup).toBeDefined();
    expect(sonyGroup!.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('treats each unique extraction as its own group when no matches', () => {
    const extractions = [
      makeExtraction('e1', { name: 'A' }, 'https://a.com'),
      makeExtraction('e2', { name: 'B' }, 'https://b.com'),
    ];

    const groups = matchEntitiesExact(extractions, ['name']);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
  });

  it('handles case-insensitive matching for strings', () => {
    const extractions = [
      makeExtraction('e1', { name: 'Sony XM5' }, 'https://a.com'),
      makeExtraction('e2', { name: 'sony xm5' }, 'https://b.com'),
    ];

    const groups = matchEntitiesExact(extractions, ['name']);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('uses multiple key fields for matching', () => {
    const extractions = [
      makeExtraction('e1', { brand: 'Sony', model: 'XM5' }, 'https://a.com'),
      makeExtraction('e2', { brand: 'Sony', model: 'XM4' }, 'https://b.com'),
      makeExtraction('e3', { brand: 'Sony', model: 'XM5' }, 'https://c.com'),
    ];

    const groups = matchEntitiesExact(extractions, ['brand', 'model']);
    expect(groups).toHaveLength(2);
    const xm5Group = groups.find((g) => g.length === 2);
    expect(xm5Group!.map((e) => e.id).sort()).toEqual(['e1', 'e3']);
  });

  it('skips extractions with missing key fields', () => {
    const extractions = [
      makeExtraction('e1', { name: 'Sony XM5' }, 'https://a.com'),
      makeExtraction('e2', {}, 'https://b.com'), // missing key
    ];

    const groups = matchEntitiesExact(extractions, ['name']);
    expect(groups).toHaveLength(2); // each in own group
  });
});

describe('matchEntitiesCompositeKey', () => {
  it('matches on composite key with partial overlap', () => {
    const extractions = [
      makeExtraction('e1', { brand: 'Sony', model: 'XM5', sku: 'S-XM5' }, 'https://a.com'),
      makeExtraction('e2', { brand: 'Sony', model: 'XM5' }, 'https://b.com'), // missing sku
      makeExtraction('e3', { brand: 'Bose', model: 'QC45' }, 'https://c.com'),
    ];

    const groups = matchEntitiesCompositeKey(extractions, ['brand', 'model', 'sku'], 0.6);
    // e1 and e2 share brand+model (2/3 keys = 0.67 > 0.6 threshold) → grouped
    expect(groups).toHaveLength(2);
    const sonyGroup = groups.find((g) => g.length === 2);
    expect(sonyGroup).toBeDefined();
  });

  it('does not match when overlap is below threshold', () => {
    const extractions = [
      makeExtraction('e1', { brand: 'Sony', model: 'XM5', sku: 'S-XM5' }, 'https://a.com'),
      makeExtraction('e2', { brand: 'Sony' }, 'https://b.com'), // only brand matches
    ];

    const groups = matchEntitiesCompositeKey(extractions, ['brand', 'model', 'sku'], 0.6);
    // 1/3 keys = 0.33 < 0.6 → separate
    expect(groups).toHaveLength(2);
  });

  it('handles empty key fields', () => {
    const extractions = [makeExtraction('e1', {}, 'https://a.com')];

    const groups = matchEntitiesCompositeKey(extractions, ['brand', 'model'], 0.5);
    expect(groups).toHaveLength(1);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement entity matcher

```typescript
// packages/core/src/reconciliation/entity-matcher.ts
import type { ExtractionResult } from '../types/extraction.js';

/**
 * ExtractionResult enriched with page-level source metadata
 * needed for entity matching and provenance tracking.
 */
export interface ExtractionWithSource extends ExtractionResult {
  sourceUrl: string;
  sourceDomain: string;
  crawledAt: Date;
}

function normalizeKeyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.toLowerCase().trim();
  return String(value);
}

function buildExactKey(extraction: ExtractionWithSource, keyFields: string[]): string {
  return keyFields.map((f) => normalizeKeyValue(extraction.data[f])).join('||');
}

/**
 * Groups extractions where all key field values match exactly (case-insensitive for strings).
 */
export function matchEntitiesExact(
  extractions: ExtractionWithSource[],
  keyFields: string[],
): ExtractionWithSource[][] {
  const groups = new Map<string, ExtractionWithSource[]>();

  for (const extraction of extractions) {
    const key = buildExactKey(extraction, keyFields);
    const existing = groups.get(key);
    if (existing) {
      existing.push(extraction);
    } else {
      groups.set(key, [extraction]);
    }
  }

  return Array.from(groups.values());
}

function computeCompositeKeyOverlap(
  a: ExtractionWithSource,
  b: ExtractionWithSource,
  keyFields: string[],
): number {
  let matchingKeys = 0;
  let comparableKeys = 0;

  for (const field of keyFields) {
    const aVal = normalizeKeyValue(a.data[field]);
    const bVal = normalizeKeyValue(b.data[field]);

    // Skip if both are empty (not comparable)
    if (!aVal && !bVal) continue;

    comparableKeys++;
    if (aVal && bVal && aVal === bVal) {
      matchingKeys++;
    }
  }

  if (comparableKeys === 0) return 0;
  return matchingKeys / comparableKeys;
}

/**
 * Groups extractions using composite key matching.
 * Two extractions match if the fraction of shared key fields >= threshold.
 * Uses union-find to handle transitive matches (A matches B, B matches C → all grouped).
 */
export function matchEntitiesCompositeKey(
  extractions: ExtractionWithSource[],
  keyFields: string[],
  threshold: number,
): ExtractionWithSource[][] {
  const n = extractions.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const overlap = computeCompositeKeyOverlap(extractions[i], extractions[j], keyFields);
      if (overlap >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, ExtractionWithSource[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(extractions[i]);
    } else {
      groups.set(root, [extractions[i]]);
    }
  }

  return Array.from(groups.values());
}
```

### Step 4: Run tests — expect PASS

### Step 5: Commit

```bash
git add packages/core/src/reconciliation/entity-matcher.ts packages/core/tests/unit/reconciliation/entity-matcher.test.ts
git commit -m "feat(core): add entity matcher with exact and composite key strategies"
```

---

## Task 3: Entity Matcher — Fuzzy & LLM-Assisted Strategies

Extend the entity matcher with fuzzy string matching and LLM-assisted matching for ambiguous cases.

**Files:**

- Modify: `packages/core/src/reconciliation/entity-matcher.ts`
- Test: `packages/core/tests/unit/reconciliation/entity-matcher.test.ts` (extend)

### Step 1: Write failing tests

Add to the existing test file:

```typescript
import {
  matchEntitiesFuzzy,
  matchEntitiesLLM,
  levenshteinSimilarity,
} from '../../../src/reconciliation/entity-matcher.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';

describe('levenshteinSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(levenshteinSimilarity('abc', 'xyz')).toBe(0);
  });

  it('returns correct similarity for similar strings', () => {
    const sim = levenshteinSimilarity('Sony XM5', 'Sony XM-5');
    expect(sim).toBeGreaterThan(0.8);
  });

  it('is case-insensitive', () => {
    expect(levenshteinSimilarity('Sony', 'sony')).toBe(1);
  });
});

describe('matchEntitiesFuzzy', () => {
  it('groups extractions with similar key values above threshold', () => {
    const extractions = [
      makeExtraction('e1', { name: 'Sony WH-1000XM5' }, 'https://a.com'),
      makeExtraction('e2', { name: 'Sony WH1000XM5' }, 'https://b.com'), // missing hyphens
      makeExtraction('e3', { name: 'Bose QC45' }, 'https://c.com'),
    ];

    const groups = matchEntitiesFuzzy(extractions, ['name'], 0.8);
    expect(groups).toHaveLength(2);
    const sonyGroup = groups.find((g) => g.length === 2);
    expect(sonyGroup).toBeDefined();
  });

  it('keeps dissimilar entries separate', () => {
    const extractions = [
      makeExtraction('e1', { name: 'Sony XM5' }, 'https://a.com'),
      makeExtraction('e2', { name: 'Bose QC45' }, 'https://b.com'),
    ];

    const groups = matchEntitiesFuzzy(extractions, ['name'], 0.8);
    expect(groups).toHaveLength(2);
  });
});

describe('matchEntitiesLLM', () => {
  function createMockClient(content: string): LLMClient {
    return {
      complete: vi.fn().mockResolvedValue({
        content,
        model: 'test-model',
        usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
        finishReason: 'stop',
      } satisfies LLMCompletionResponse),
    };
  }

  const llmConfig: LLMConfig = { primaryModel: 'test-model' };

  it('groups extractions based on LLM entity matching response', async () => {
    const extractions = [
      makeExtraction('e1', { name: 'Sony XM5 Headphones', price: 379 }, 'https://amazon.com/p1'),
      makeExtraction('e2', { name: 'Sony WH-1000XM5', price: 349 }, 'https://bestbuy.com/p2'),
      makeExtraction('e3', { name: 'Bose QuietComfort 45', price: 279 }, 'https://amazon.com/p3'),
    ];

    const llmResponse = JSON.stringify({
      groups: [
        {
          extractionIds: ['e1', 'e2'],
          reasoning: 'Same product, Sony WH-1000XM5',
          confidence: 0.95,
        },
        { extractionIds: ['e3'], reasoning: 'Distinct product, Bose QC45', confidence: 0.99 },
      ],
    });

    const client = createMockClient(llmResponse);
    const groups = await matchEntitiesLLM(extractions, client, llmConfig);

    expect(groups).toHaveLength(2);
    const sonyGroup = groups.find((g) => g.length === 2);
    expect(sonyGroup!.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('returns each extraction in its own group on LLM error', async () => {
    const extractions = [
      makeExtraction('e1', { name: 'A' }, 'https://a.com'),
      makeExtraction('e2', { name: 'B' }, 'https://b.com'),
    ];

    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM failed')),
    };

    const groups = await matchEntitiesLLM(extractions, client, llmConfig);
    expect(groups).toHaveLength(2); // fallback: each in own group
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement fuzzy matching and LLM matching

Add to `entity-matcher.ts`:

```typescript
import { z } from 'zod';
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('entity-matcher');

/**
 * Compute Levenshtein distance-based similarity between two strings (0-1).
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 1;

  const m = s.length;
  const n = t.length;
  if (m === 0 || n === 0) return 0;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  const maxLen = Math.max(m, n);
  return 1 - dp[m][n] / maxLen;
}

function computeFuzzyKeyOverlap(
  a: ExtractionWithSource,
  b: ExtractionWithSource,
  keyFields: string[],
  threshold: number,
): number {
  let totalSimilarity = 0;
  let comparableFields = 0;

  for (const field of keyFields) {
    const aVal = a.data[field];
    const bVal = b.data[field];

    if (aVal == null && bVal == null) continue;
    if (aVal == null || bVal == null) {
      comparableFields++;
      continue;
    }

    comparableFields++;
    totalSimilarity += levenshteinSimilarity(String(aVal), String(bVal));
  }

  if (comparableFields === 0) return 0;
  return totalSimilarity / comparableFields;
}

/**
 * Groups extractions using fuzzy string matching on key fields.
 * Uses Levenshtein similarity and union-find for transitive closure.
 */
export function matchEntitiesFuzzy(
  extractions: ExtractionWithSource[],
  keyFields: string[],
  threshold: number,
): ExtractionWithSource[][] {
  const n = extractions.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const similarity = computeFuzzyKeyOverlap(
        extractions[i],
        extractions[j],
        keyFields,
        threshold,
      );
      if (similarity >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, ExtractionWithSource[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(extractions[i]);
    } else {
      groups.set(root, [extractions[i]]);
    }
  }

  return Array.from(groups.values());
}

// --- LLM-Assisted Matching ---

const LLMEntityGroupResponse = z.object({
  groups: z.array(
    z.object({
      extractionIds: z.array(z.string()),
      reasoning: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const ENTITY_MATCH_SYSTEM_PROMPT = `You are an entity matching expert. Group the provided extraction records that represent the same real-world entity. Respond with JSON only.`;

/**
 * Uses LLM to identify which extractions represent the same entity.
 * Fallback: returns each extraction in its own group on error.
 */
export async function matchEntitiesLLM(
  extractions: ExtractionWithSource[],
  llmClient: LLMClient,
  llmConfig: LLMConfig,
): Promise<ExtractionWithSource[][]> {
  try {
    const extractionSummaries = extractions.map((e) => ({
      id: e.id,
      data: e.data,
      source: e.sourceDomain,
    }));

    const userPrompt = `Group these extraction records by entity. Records that refer to the same real-world item should be in the same group.

${JSON.stringify(extractionSummaries, null, 2)}

Respond with JSON: { "groups": [{ "extractionIds": ["id1", "id2"], "reasoning": "...", "confidence": 0.95 }] }`;

    const response = await llmClient.complete({
      model: resolveModel(llmConfig, 'entityMatching'),
      messages: [
        { role: 'system', content: ENTITY_MATCH_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
      maxTokens: 4096,
    });

    const parsed = LLMEntityGroupResponse.safeParse(JSON.parse(response.content));
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.issues }, 'invalid LLM entity match response');
      return extractions.map((e) => [e]);
    }

    const idToExtraction = new Map(extractions.map((e) => [e.id, e]));
    const groups: ExtractionWithSource[][] = [];

    for (const group of parsed.data.groups) {
      const members = group.extractionIds
        .map((id) => idToExtraction.get(id))
        .filter((e): e is ExtractionWithSource => e !== undefined);
      if (members.length > 0) {
        groups.push(members);
      }
    }

    // Add any extractions not covered by LLM response as singletons
    const coveredIds = new Set(groups.flatMap((g) => g.map((e) => e.id)));
    for (const extraction of extractions) {
      if (!coveredIds.has(extraction.id)) {
        groups.push([extraction]);
      }
    }

    return groups;
  } catch (error) {
    logger.error({ error }, 'LLM entity matching failed, falling back to singletons');
    return extractions.map((e) => [e]);
  }
}
```

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 4: Source Trust Evaluator

LLM-powered evaluation of source domain trustworthiness. Produces `set_source_trust` actions.

**Files:**

- Create: `packages/core/src/reconciliation/source-trust-evaluator.ts`
- Test: `packages/core/tests/unit/reconciliation/source-trust-evaluator.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SourceTrustEvaluator } from '../../../src/reconciliation/source-trust-evaluator.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const llmConfig: LLMConfig = { primaryModel: 'test-model' };

describe('SourceTrustEvaluator', () => {
  it('evaluates domain trust levels via LLM', async () => {
    const response = JSON.stringify({
      rankings: [
        {
          domain: 'amazon.com',
          trustLevel: 'high',
          reasoning: 'Major retailer with accurate product data',
        },
        {
          domain: 'sketchy-deals.com',
          trustLevel: 'low',
          reasoning: 'Unknown reseller, possibly inaccurate',
        },
      ],
    });

    const client = createMockClient(response);
    const evaluator = new SourceTrustEvaluator(client, llmConfig);

    const actions = await evaluator.evaluate(
      ['amazon.com', 'sketchy-deals.com'],
      'audiophile headphones',
    );

    expect(actions).toHaveLength(1); // one set_source_trust action
    expect(actions[0].type).toBe('set_source_trust');
    if (actions[0].type !== 'set_source_trust') throw new Error('wrong type');
    expect(actions[0].payload.rankings).toHaveLength(2);
    expect(actions[0].payload.rankings[0].domain).toBe('amazon.com');
    expect(actions[0].payload.rankings[0].trustLevel).toBe('high');
  });

  it('respects user-provided source priority', async () => {
    const evaluator = new SourceTrustEvaluator(createMockClient('{}'), llmConfig);

    const actions = await evaluator.evaluateWithPriority(
      ['official.sony.com', 'amazon.com', 'random-site.com'],
      ['official.sony.com', 'amazon.com'],
    );

    expect(actions).toHaveLength(1);
    if (actions[0].type !== 'set_source_trust') throw new Error('wrong type');
    // Priority sources get higher trust
    expect(actions[0].payload.rankings[0].domain).toBe('official.sony.com');
    expect(actions[0].payload.rankings[0].trustLevel).toBe('authoritative');
    expect(actions[0].payload.rankings[1].trustLevel).toBe('high');
    expect(actions[0].payload.rankings[2].trustLevel).toBe('medium');
  });

  it('returns empty array on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM failed')),
    };
    const evaluator = new SourceTrustEvaluator(client, llmConfig);

    const actions = await evaluator.evaluate(['test.com'], 'test');
    expect(actions).toEqual([]);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement source trust evaluator

The evaluator should use `generateId()` from `@spatula/shared`, call LLM with `resolveModel(config, 'entityMatching')`, produce `set_source_trust` PipelineAction objects, and also support a non-LLM `evaluateWithPriority()` method that assigns trust based on user-provided source priority order.

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 5: Conflict Resolver

When matched entities have conflicting field values across sources, resolve using one of 5 strategies.

**Files:**

- Create: `packages/core/src/reconciliation/conflict-resolver.ts`
- Test: `packages/core/tests/unit/reconciliation/conflict-resolver.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  resolveConflict,
  type FieldConflict,
} from '../../../src/reconciliation/conflict-resolver.js';
import type { SourceTrust } from '../../../src/types/reconciliation.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';

describe('resolveConflict', () => {
  const conflict: FieldConflict = {
    fieldName: 'price',
    values: [
      {
        source: 'amazon.com',
        value: 379.99,
        extractionId: 'e1',
        crawledAt: new Date('2026-01-01'),
      },
      {
        source: 'bestbuy.com',
        value: 349.99,
        extractionId: 'e2',
        crawledAt: new Date('2026-01-05'),
      },
      {
        source: 'walmart.com',
        value: 379.99,
        extractionId: 'e3',
        crawledAt: new Date('2026-01-03'),
      },
    ],
  };

  it('resolves with most_common strategy — picks most frequent value', () => {
    const result = resolveConflict(conflict, 'most_common');

    expect(result.resolvedValue).toBe(379.99);
    expect(result.sourcePreferred).toBe('amazon.com');
    expect(result.resolution).toBe('most_common');
  });

  it('resolves with most_recent strategy — picks latest extraction', () => {
    const result = resolveConflict(conflict, 'most_recent');

    expect(result.resolvedValue).toBe(349.99);
    expect(result.sourcePreferred).toBe('bestbuy.com');
    expect(result.resolution).toBe('most_recent');
  });

  it('resolves with source_priority strategy — picks from highest trust source', () => {
    const trustRankings: SourceTrust[] = [
      { domain: 'bestbuy.com', trustLevel: 'authoritative', reasoning: 'official retailer' },
      { domain: 'amazon.com', trustLevel: 'high', reasoning: 'major retailer' },
      { domain: 'walmart.com', trustLevel: 'medium', reasoning: 'general retailer' },
    ];

    const result = resolveConflict(conflict, 'source_priority', { trustRankings });

    expect(result.resolvedValue).toBe(349.99);
    expect(result.sourcePreferred).toBe('bestbuy.com');
  });

  it('resolves with most_complete strategy', () => {
    const nameConflict: FieldConflict = {
      fieldName: 'name',
      values: [
        { source: 'a.com', value: 'Sony', extractionId: 'e1', crawledAt: new Date() },
        {
          source: 'b.com',
          value: 'Sony WH-1000XM5 Wireless Headphones',
          extractionId: 'e2',
          crawledAt: new Date(),
        },
      ],
    };

    const result = resolveConflict(nameConflict, 'most_complete');
    // most_complete picks the longest/most detailed value
    expect(result.resolvedValue).toBe('Sony WH-1000XM5 Wireless Headphones');
  });

  it('handles single-value conflict (no actual conflict)', () => {
    const single: FieldConflict = {
      fieldName: 'brand',
      values: [{ source: 'a.com', value: 'Sony', extractionId: 'e1', crawledAt: new Date() }],
    };

    const result = resolveConflict(single, 'most_common');
    expect(result.resolvedValue).toBe('Sony');
    expect(result.hadConflict).toBe(false);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement conflict resolver

The resolver should:

- Accept a `FieldConflict` (field name + array of source/value pairs)
- Return a `ResolvedField` with resolvedValue, sourcePreferred, hadConflict, and resolution strategy used
- For `most_common`: count occurrences, pick the most frequent value
- For `most_recent`: pick the value with the latest `crawledAt`
- For `source_priority`: use `SourceTrust` rankings (authoritative > high > medium > low)
- For `most_complete`: pick the value with the longest string representation
- For `llm_resolved`: call LLM (separate async function)

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 6: Gap Filler

LLM-powered inference for filling missing values in matched entities.

**Files:**

- Create: `packages/core/src/reconciliation/gap-filler.ts`
- Test: `packages/core/tests/unit/reconciliation/gap-filler.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GapFiller } from '../../../src/reconciliation/gap-filler.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const llmConfig: LLMConfig = { primaryModel: 'test-model' };

const schema: SchemaDefinition = {
  version: 3,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'brand', description: 'Brand name', type: 'string', required: true },
    { name: 'price', description: 'Price in USD', type: 'currency', required: true },
    { name: 'weight', description: 'Weight in grams', type: 'number', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: 2,
};

describe('GapFiller', () => {
  it('proposes inferred values for missing required fields', async () => {
    const response = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Extracted from product name "Sony WH-1000XM5"',
          confidence: 0.95,
        },
      ],
    });

    const client = createMockClient(response);
    const filler = new GapFiller(client, llmConfig);

    const mergedData = { product_name: 'Sony WH-1000XM5', price: 379.99 };
    const actions = await filler.fillGaps('entity-1', mergedData, schema, 'headphones');

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('infer_value');
    if (actions[0].type !== 'infer_value') throw new Error('wrong type');
    expect(actions[0].payload.entityId).toBe('entity-1');
    expect(actions[0].payload.fieldName).toBe('brand');
    expect(actions[0].payload.inferredValue).toBe('Sony');
  });

  it('does not propose inferences when all required fields present', async () => {
    const client = createMockClient(JSON.stringify({ inferences: [] }));
    const filler = new GapFiller(client, llmConfig);

    const mergedData = { product_name: 'Test', brand: 'Sony', price: 100 };
    const actions = await filler.fillGaps('entity-1', mergedData, schema, 'headphones');

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled(); // no missing required fields
  });

  it('returns empty array on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const filler = new GapFiller(client, llmConfig);

    const mergedData = { product_name: 'Test' };
    const actions = await filler.fillGaps('entity-1', mergedData, schema, 'headphones');

    expect(actions).toEqual([]);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement gap filler

The GapFiller should:

- Identify missing required fields from the schema
- Skip LLM call if no gaps exist
- Call LLM with entity data + schema fields + job description
- Validate response with Zod
- Return `infer_value` PipelineActions
- Use `resolveModel(config, 'conflictResolution')` for LLM calls

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 7: DataReconcilerImpl — Full Pipeline Orchestrator

Implements the `DataReconciler` interface. Orchestrates: normalize → evaluate trust → match entities → merge → resolve conflicts → fill gaps → build EntityMatch objects.

**Files:**

- Create: `packages/core/src/reconciliation/data-reconciler-impl.ts`
- Test: `packages/core/tests/unit/reconciliation/data-reconciler-impl.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DataReconcilerImpl } from '../../../src/reconciliation/data-reconciler-impl.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig, ReconciliationConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';
import type { ExtractionWithSource } from '../../../src/reconciliation/entity-matcher.js';

function createMockClient(responses: string[]): LLMClient {
  const fn = vi.fn();
  for (const content of responses) {
    fn.mockResolvedValueOnce({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse);
  }
  return { complete: fn };
}

const llmConfig: LLMConfig = { primaryModel: 'test-model' };

const schema: SchemaDefinition = {
  version: 1,
  fields: [
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
    { name: 'price', description: 'Price', type: 'currency', required: true },
    { name: 'brand', description: 'Brand', type: 'string', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const config: ReconciliationConfig = {
  matchStrategy: 'exact_name',
  conflictResolution: 'most_common',
  fuzzyMatchThreshold: 0.85,
  enableLLMMatching: false,
};

describe('DataReconcilerImpl', () => {
  it('produces entities with merged data and provenance', async () => {
    const client = createMockClient([]);
    const reconciler = new DataReconcilerImpl(client, llmConfig);

    const enrichedExtractions: ExtractionWithSource[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        jobId: '00000000-0000-0000-0000-000000000100',
        pageId: '00000000-0000-0000-0000-000000000010',
        schemaVersion: 1,
        data: { product_name: '  sony xm5  ', price: 379.99, brand: 'Sony' },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
        sourceUrl: 'https://amazon.com/p1',
        sourceDomain: 'amazon.com',
        crawledAt: new Date('2026-01-01'),
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        jobId: '00000000-0000-0000-0000-000000000100',
        pageId: '00000000-0000-0000-0000-000000000020',
        schemaVersion: 1,
        data: { product_name: 'sony xm5', price: 349.99 },
        metadata: {
          confidence: 0.85,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
        sourceUrl: 'https://bestbuy.com/p1',
        sourceDomain: 'bestbuy.com',
        crawledAt: new Date('2026-01-05'),
      },
    ];

    const result = await reconciler.reconcile(enrichedExtractions, schema, config, 'headphones');

    // Should produce 1 entity (both extractions match on product_name after normalization)
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].sourceExtractions).toHaveLength(2);
    expect(result.entities[0].mergedData.product_name).toBe('Sony Xm5'); // normalized
    expect(result.entities[0].fieldProvenance.product_name.provenanceType).toBe('normalized');
    expect(result.entities[0].fieldProvenance.price.hadConflict).toBe(true);
  });

  it('returns empty entities for empty extractions', async () => {
    const client = createMockClient([]);
    const reconciler = new DataReconcilerImpl(client, llmConfig);

    const result = await reconciler.reconcile([], schema, config, 'test');
    expect(result.entities).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it('generates match_entities and resolve_conflict actions', async () => {
    const client = createMockClient([]);
    const reconciler = new DataReconcilerImpl(client, llmConfig);

    const enrichedExtractions: ExtractionWithSource[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        jobId: '00000000-0000-0000-0000-000000000100',
        pageId: '00000000-0000-0000-0000-000000000010',
        schemaVersion: 1,
        data: { product_name: 'Sony XM5', price: 379.99 },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
        sourceUrl: 'https://a.com/1',
        sourceDomain: 'a.com',
        crawledAt: new Date('2026-01-01'),
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        jobId: '00000000-0000-0000-0000-000000000100',
        pageId: '00000000-0000-0000-0000-000000000020',
        schemaVersion: 1,
        data: { product_name: 'Sony XM5', price: 349.99 },
        metadata: {
          confidence: 0.85,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
        sourceUrl: 'https://b.com/1',
        sourceDomain: 'b.com',
        crawledAt: new Date('2026-01-05'),
      },
    ];

    const result = await reconciler.reconcile(enrichedExtractions, schema, config, 'headphones');

    const matchAction = result.actions.find((a) => a.type === 'match_entities');
    expect(matchAction).toBeDefined();

    const conflictAction = result.actions.find((a) => a.type === 'resolve_conflict');
    expect(conflictAction).toBeDefined();
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement DataReconcilerImpl

The implementation should:

1. Normalize all extraction data against schema rules
2. Match entities using the configured strategy (exact/composite/fuzzy/llm)
3. For each entity group: merge data, detect conflicts, resolve conflicts, build provenance
4. Optionally fill gaps for missing required fields
5. Build `EntityMatch` objects and collect all `PipelineAction` objects
6. Identify key fields for matching from schema required fields

Note: The `DataReconciler` interface signature needs a minor update — add `jobDescription: string` parameter and accept `ExtractionWithSource[]` instead of plain `ExtractionResult[]`. Update the interface in `packages/core/src/interfaces/reconciler.ts` accordingly.

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 8: Reconciliation Barrel Exports

Create barrel exports for the reconciliation module and update core package exports.

**Files:**

- Create: `packages/core/src/reconciliation/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/unit/reconciliation/exports.test.ts`

### Step 1: Write failing test

```typescript
import { describe, it, expect } from 'vitest';
import * as reconciliation from '../../../src/reconciliation/index.js';

describe('reconciliation exports', () => {
  it('exports applyNormalizationRule', () => {
    expect(reconciliation.applyNormalizationRule).toBeTypeOf('function');
  });

  it('exports normalizeExtractionData', () => {
    expect(reconciliation.normalizeExtractionData).toBeTypeOf('function');
  });

  it('exports matchEntitiesExact', () => {
    expect(reconciliation.matchEntitiesExact).toBeTypeOf('function');
  });

  it('exports matchEntitiesCompositeKey', () => {
    expect(reconciliation.matchEntitiesCompositeKey).toBeTypeOf('function');
  });

  it('exports matchEntitiesFuzzy', () => {
    expect(reconciliation.matchEntitiesFuzzy).toBeTypeOf('function');
  });

  it('exports matchEntitiesLLM', () => {
    expect(reconciliation.matchEntitiesLLM).toBeTypeOf('function');
  });

  it('exports levenshteinSimilarity', () => {
    expect(reconciliation.levenshteinSimilarity).toBeTypeOf('function');
  });

  it('exports SourceTrustEvaluator', () => {
    expect(reconciliation.SourceTrustEvaluator).toBeTypeOf('function');
  });

  it('exports resolveConflict', () => {
    expect(reconciliation.resolveConflict).toBeTypeOf('function');
  });

  it('exports GapFiller', () => {
    expect(reconciliation.GapFiller).toBeTypeOf('function');
  });

  it('exports DataReconcilerImpl', () => {
    expect(reconciliation.DataReconcilerImpl).toBeTypeOf('function');
  });
});
```

### Step 2: Run test — expect FAIL

### Step 3: Create barrel exports

```typescript
// packages/core/src/reconciliation/index.ts
export { applyNormalizationRule, normalizeExtractionData } from './value-normalizer.js';
export type { NormalizationChange, NormalizedResult } from './value-normalizer.js';
export {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  matchEntitiesFuzzy,
  matchEntitiesLLM,
  levenshteinSimilarity,
} from './entity-matcher.js';
export type { ExtractionWithSource } from './entity-matcher.js';
export { SourceTrustEvaluator } from './source-trust-evaluator.js';
export { resolveConflict } from './conflict-resolver.js';
export type { FieldConflict, ResolvedField } from './conflict-resolver.js';
export { GapFiller } from './gap-filler.js';
export { DataReconcilerImpl } from './data-reconciler-impl.js';
```

Update `packages/core/src/index.ts` — add `export * from './reconciliation/index.js';`

### Step 4: Run tests — expect PASS

### Step 5: Commit

---

## Task 9: DB Repositories — Entity, SourceTrust, EntitySource

Implement repositories for the three Phase 7 database tables.

**Files:**

- Create: `packages/db/src/repositories/entity-repository.ts`
- Create: `packages/db/src/repositories/source-trust-repository.ts`
- Create: `packages/db/src/repositories/entity-source-repository.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/unit/repositories/entity-repository.test.ts`
- Test: `packages/db/tests/unit/repositories/source-trust-repository.test.ts`
- Test: `packages/db/tests/unit/repositories/entity-source-repository.test.ts`

### Step 1: Write failing tests for EntityRepository

Follow the existing repository pattern (see `extraction-repository.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityRepository } from '../../../src/repositories/entity-repository.js';

// Mock the database using the same pattern as existing repo tests
// Test methods: create, findById, findByJob, updateQualityScore

describe('EntityRepository', () => {
  it('creates an entity with merged data and provenance', async () => {
    /* ... */
  });
  it('finds entities by job with optional category filter', async () => {
    /* ... */
  });
  it('finds entity by id', async () => {
    /* ... */
  });
  it('updates quality score', async () => {
    /* ... */
  });
  it('wraps errors in StorageError', async () => {
    /* ... */
  });
});
```

### Step 2: Write failing tests for SourceTrustRepository

```typescript
describe('SourceTrustRepository', () => {
  it('upserts source trust for a domain', async () => {
    /* ... */
  });
  it('finds all trust records for a job', async () => {
    /* ... */
  });
  it('finds trust for a specific domain', async () => {
    /* ... */
  });
});
```

### Step 3: Write failing tests for EntitySourceRepository

```typescript
describe('EntitySourceRepository', () => {
  it('links an extraction to an entity', async () => {
    /* ... */
  });
  it('finds all extractions linked to an entity', async () => {
    /* ... */
  });
  it('bulk links multiple extractions', async () => {
    /* ... */
  });
});
```

### Step 4: Implement all three repositories

**EntityRepository:**

- `create(input)` — insert into entities table, return row
- `findById(entityId, tenantId)` — select by id + tenant
- `findByJob(jobId, tenantId, options?)` — select by job, optional category filter via `arrayContains`, limit, offset
- `updateQualityScore(entityId, tenantId, score)` — update quality_score

**SourceTrustRepository:**

- `upsert(input)` — insert or update on conflict (jobId + domain)
- `findByJob(jobId, tenantId)` — all trust records for a job
- `findByDomain(domain, jobId, tenantId)` — single domain trust

**EntitySourceRepository:**

- `link(entityId, extractionId, matchConfidence)` — insert into entity_sources
- `bulkLink(links: Array<{entityId, extractionId, matchConfidence}>)` — batch insert
- `findByEntity(entityId)` — all linked extractions

### Step 5: Update barrel exports

Add to `packages/db/src/repositories/index.ts`:

```typescript
export { EntityRepository } from './entity-repository.js';
export { SourceTrustRepository } from './source-trust-repository.js';
export { EntitySourceRepository } from './entity-source-repository.js';
```

### Step 6: Run all DB tests — expect PASS

### Step 7: Commit

---

## Task 10: Reconciliation Queue, Worker, and Integration

Add a reconciliation BullMQ queue, implement the worker, update WorkerDeps, and wire reconciliation trigger into JobManager.

**Files:**

- Modify: `packages/queue/src/queues.ts`
- Modify: `packages/queue/src/worker-deps.ts`
- Create: `packages/queue/src/workers/reconciliation-worker.ts`
- Modify: `packages/queue/src/job-manager.ts`
- Modify: `packages/queue/src/index.ts` (if needed)
- Test: `packages/queue/tests/unit/workers/reconciliation-worker.test.ts`
- Test: `packages/queue/tests/unit/job-manager.test.ts` (extend)

### Step 1: Add ReconciliationJobData to queues.ts

```typescript
export const QUEUE_NAMES = {
  CRAWL: 'spatula:crawl',
  EXTRACT: 'spatula:extract',
  SCHEMA_EVOLUTION: 'spatula:schema-evolution',
  RECONCILIATION: 'spatula:reconciliation',
} as const;

export interface ReconciliationJobData {
  jobId: string;
  tenantId: string;
}
```

Add reconciliation queue to `SpatulaQueues` and `createQueues`.

### Step 2: Update WorkerDeps

Add to `WorkerDepsConfig` and `WorkerDeps`:

```typescript
reconciler: DataReconciler;
entityRepo: EntityRepository;
sourceTrustRepo: SourceTrustRepository;
entitySourceRepo: EntitySourceRepository;
```

### Step 3: Write failing tests for reconciliation worker

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconciliationJob } from '../../../src/workers/reconciliation-worker.js';

describe('processReconciliationJob', () => {
  it('loads extractions, reconciles, and persists entities', async () => {
    // Mock deps with reconciler that returns entities
    // Verify: jobRepo.findById called, extractionRepo.findByJob called,
    //   reconciler.reconcile called, entityRepo.create called for each entity,
    //   entitySourceRepo.bulkLink called, jobRepo.updateStatus → 'completed'
  });

  it('transitions job to completed on success', async () => {
    /* ... */
  });
  it('transitions job to failed on error', async () => {
    /* ... */
  });
  it('skips if job not found', async () => {
    /* ... */
  });
  it('enriches extractions with page metadata before reconciling', async () => {
    /* ... */
  });
});
```

### Step 4: Implement reconciliation worker

```typescript
// packages/queue/src/workers/reconciliation-worker.ts
export async function processReconciliationJob(
  data: ReconciliationJobData,
  deps: WorkerDeps,
): Promise<void> {
  const { jobId, tenantId } = data;
  try {
    // 1. Load job config
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId }, 'job not found');
      return;
    }

    const config = job.config as JobConfig;

    // 2. Load final schema
    const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!currentSchema) {
      /* skip */ return;
    }

    // 3. Load ALL extractions for the job
    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId);

    // 4. Enrich extractions with page metadata (sourceUrl, crawledAt)
    const enriched = await enrichExtractions(extractions, deps);

    // 5. Reconcile
    const reconciliationConfig = config.reconciliation ?? {
      matchStrategy: 'composite_key',
      conflictResolution: 'most_complete',
      fuzzyMatchThreshold: 0.85,
      enableLLMMatching: true,
    };

    const result = await deps.reconciler.reconcile(
      enriched,
      currentSchema.definition,
      reconciliationConfig,
      config.description,
    );

    // 6. Persist entities
    for (const entity of result.entities) {
      const row = await deps.entityRepo.create({
        jobId,
        tenantId,
        mergedData: entity.mergedData,
        provenance: entity.fieldProvenance as Record<string, unknown>,
        categories: [],
        qualityScore: computeQualityScore(entity),
      });

      // Link extractions to entity
      const links = entity.sourceExtractions.map((se) => ({
        entityId: row.id,
        extractionId: se.extractionId,
        matchConfidence: 0.9, // from match action if available
      }));
      await deps.entitySourceRepo.bulkLink(links);
    }

    // 7. Persist source trust if set_source_trust actions present
    for (const action of result.actions) {
      if (action.type === 'set_source_trust') {
        for (const ranking of action.payload.rankings) {
          await deps.sourceTrustRepo.upsert({
            jobId,
            tenantId,
            domain: ranking.domain,
            trustLevel: ranking.trustLevel,
            reasoning: ranking.reasoning,
          });
        }
      }
    }

    // 8. Update job status → completed
    await deps.jobRepo.updateStatus(jobId, tenantId, 'completed');

    logger.info({ jobId, entityCount: result.entities.length }, 'reconciliation complete');
  } catch (error) {
    logger.error({ jobId, error }, 'reconciliation job failed');
    await deps.jobRepo.updateStatus(jobId, tenantId, 'failed').catch(() => {});
  }
}
```

### Step 5: Add triggerReconciliation to JobManager

```typescript
async triggerReconciliation(jobId: string, tenantId: string): Promise<void> {
  const job = await this.getJob(jobId, tenantId);
  JobStateMachine.transition(job.status as JobStatus, 'reconciling');
  await this.jobRepo.updateStatus(jobId, tenantId, 'reconciling');

  await this.queues.reconciliation.add(`reconciliation:${jobId}`, {
    jobId,
    tenantId,
  });

  logger.info({ jobId }, 'reconciliation triggered');
}
```

### Step 6: Update queue package exports

Ensure `ReconciliationJobData`, the worker, and updated `JobManager` are exported.

### Step 7: Run all tests — expect PASS

### Step 8: Commit

---

## Final Verification

After all 10 tasks:

```bash
pnpm build && pnpm lint && pnpm format:check && pnpm test
```

Expected: All packages build, lint, format, and test clean. Total test count should increase by ~60-80 new tests.
