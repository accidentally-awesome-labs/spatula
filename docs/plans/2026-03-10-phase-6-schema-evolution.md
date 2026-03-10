# Phase 6: Intelligent Schema Evolution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the schema evolution engine that dynamically expands extraction schemas as the crawler discovers new data patterns, using category-aware field relevance and LLM-powered analysis.

**Architecture:** The `SchemaEvolver` implementation lives in `packages/core/src/evolution/` and follows the same LLM integration pattern as `StaticExtractor` and `PageClassifier`. It analyzes batches of recent extractions (specifically their `unmappedFields`), uses the LLM to propose schema actions (`add_field`, `merge_fields`, `set_normalization_rule`, etc.), then applies auto-approved actions to produce new schema versions. The schema evolution worker in `packages/queue` consumes batched evolution jobs and orchestrates the full pipeline. The crawl worker triggers evolution every N extractions.

**Tech Stack:** TypeScript, Zod validation, OpenRouter LLM (via existing `LLMClient`), BullMQ (existing queues), Vitest

---

## Context for Implementer

### Key Files

| File                                                    | Purpose                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/core/src/interfaces/schema-evolver.ts`        | Interface to implement (already exists)                               |
| `packages/core/src/types/schema.ts`                     | `SchemaDefinition`, `FieldDefinition`, `FieldRelevance`, `FieldAlias` |
| `packages/core/src/types/actions.ts`                    | All `PipelineAction` types (25 action types)                          |
| `packages/core/src/types/extraction.ts`                 | `ExtractionResult`, `UnmappedField`                                   |
| `packages/core/src/types/job.ts`                        | `EvolutionConfig`, `JobConfig`, `LLMConfig`                           |
| `packages/core/src/types/normalization.ts`              | `NormalizationRule` discriminated union                               |
| `packages/core/src/extraction/static-extractor.ts`      | Reference LLM integration pattern                                     |
| `packages/core/src/extraction/page-classifier.ts`       | Reference Zod validation pattern                                      |
| `packages/core/src/llm/model-router.ts`                 | `resolveModel(config, 'schemaEvolution')`                             |
| `packages/queue/src/workers/schema-worker.ts`           | Stub to complete                                                      |
| `packages/queue/src/worker-deps.ts`                     | Dependency container to extend                                        |
| `packages/queue/src/workers/crawl-worker.ts`            | Trigger evolution after N extractions                                 |
| `packages/db/src/repositories/extraction-repository.ts` | `findByJob()` for batch queries                                       |
| `packages/db/src/repositories/schema-repository.ts`     | `create()`, `findLatest()` for versioning                             |

### Type Signatures Already Defined

```typescript
// Interface to implement
interface SchemaEvolver {
  evolve(
    currentSchema: SchemaDefinition,
    recentExtractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]>;
}

// Schema evolution job data (already in queues.ts)
interface SchemaEvolutionJobData {
  jobId: string;
  tenantId: string;
  extractionIds: string[];
}

// Evolution config (already in job.ts)
interface EvolutionConfig {
  enabled: boolean;
  batchSize: number; // Default 10
  maxFields: number; // Default 50
  relevanceThresholds: {
    requiredMin: number; // Default 0.85
    optionalMin: number; // Default 0.4
    rareBelow: number; // Default 0.4
    minCategorySampleSize: number; // Default 5
  };
  tableStrategy: 'single' | 'multi' | 'auto';
}
```

### Design Doc Requirements (from `docs/plans/2026-03-06-spatula-design.md`)

1. **Category-aware field relevance** — fields evaluated both globally AND per-category
2. **Batched every N extractions** — configurable batch size, default 10
3. **Distributed lock** — prevent concurrent evolutions for same job
4. **Action types generated:** `add_field`, `merge_fields`, `modify_field`, `set_normalization_rule`, `update_enum_map`, `define_category`, `assign_category_fields`
5. **Safety policies:** `add_field` = auto_above_threshold, `merge_fields` = batch_review, `remove_field` = always_review
6. **Schema versioning:** each evolution creates a new version with `parentVersion` chain

---

## Task 1: Unmapped Field Aggregator

**Files:**

- Create: `packages/core/src/evolution/unmapped-aggregator.ts`
- Test: `packages/core/tests/unit/evolution/unmapped-aggregator.test.ts`

Pure function that collects unmapped fields from a batch of extractions and aggregates them by name (case-insensitive), tracking frequency, source URLs, observed types, and sample values.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateUnmappedFields } from '../../../src/evolution/unmapped-aggregator.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

function makeExtraction(
  overrides: Partial<ExtractionResult> & { metadata: any },
): ExtractionResult {
  return {
    id: 'ext-1',
    jobId: 'job-1',
    pageId: 'page-1',
    schemaVersion: 1,
    data: {},
    ...overrides,
  } as ExtractionResult;
}

describe('aggregateUnmappedFields', () => {
  it('groups unmapped fields by normalized name', () => {
    const extractions: ExtractionResult[] = [
      makeExtraction({
        id: 'ext-1',
        pageId: 'page-1',
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [
            { name: 'brand_name', value: 'Sennheiser', suggestedType: 'string' },
            { name: 'weight', value: '300g', suggestedType: 'string' },
          ],
        },
      }),
      makeExtraction({
        id: 'ext-2',
        pageId: 'page-2',
        metadata: {
          confidence: 0.85,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [
            { name: 'Brand_Name', value: 'Audio-Technica', suggestedType: 'string' },
            { name: 'impedance', value: '32 ohms', suggestedType: 'string' },
          ],
        },
      }),
      makeExtraction({
        id: 'ext-3',
        pageId: 'page-3',
        metadata: {
          confidence: 0.95,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [{ name: 'brand_name', value: 'Beyerdynamic', suggestedType: 'string' }],
        },
      }),
    ];

    const result = aggregateUnmappedFields(extractions);

    expect(result).toHaveLength(3);

    const brandField = result.find((f) => f.normalizedName === 'brand_name');
    expect(brandField).toBeDefined();
    expect(brandField!.occurrences).toBe(3);
    expect(brandField!.frequency).toBeCloseTo(1.0); // 3/3 extractions
    expect(brandField!.sampleValues).toEqual(['Sennheiser', 'Audio-Technica', 'Beyerdynamic']);
    expect(brandField!.observedNames).toContain('Brand_Name');

    const weightField = result.find((f) => f.normalizedName === 'weight');
    expect(weightField!.occurrences).toBe(1);
    expect(weightField!.frequency).toBeCloseTo(1 / 3);
  });

  it('returns empty array for extractions with no unmapped fields', () => {
    const extractions: ExtractionResult[] = [
      makeExtraction({
        id: 'ext-1',
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
      }),
    ];

    const result = aggregateUnmappedFields(extractions);
    expect(result).toHaveLength(0);
  });

  it('caps sample values at 10', () => {
    const extractions = Array.from({ length: 15 }, (_, i) =>
      makeExtraction({
        id: `ext-${i}`,
        pageId: `page-${i}`,
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [{ name: 'color', value: `color-${i}`, suggestedType: 'string' }],
        },
      }),
    );

    const result = aggregateUnmappedFields(extractions);
    const colorField = result.find((f) => f.normalizedName === 'color');
    expect(colorField!.sampleValues).toHaveLength(10);
  });

  it('tracks the most common suggested type', () => {
    const extractions: ExtractionResult[] = [
      makeExtraction({
        id: 'ext-1',
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [{ name: 'price', value: 299, suggestedType: 'number' }],
        },
      }),
      makeExtraction({
        id: 'ext-2',
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [{ name: 'price', value: '$299', suggestedType: 'currency' }],
        },
      }),
      makeExtraction({
        id: 'ext-3',
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [{ name: 'price', value: 199, suggestedType: 'number' }],
        },
      }),
    ];

    const result = aggregateUnmappedFields(extractions);
    const priceField = result.find((f) => f.normalizedName === 'price');
    expect(priceField!.dominantType).toBe('number'); // 2 out of 3
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/unmapped-aggregator.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/unmapped-aggregator.ts
import type { ExtractionResult } from '../types/extraction.js';

export interface AggregatedField {
  normalizedName: string;
  observedNames: string[];
  occurrences: number;
  frequency: number;
  dominantType: string;
  typeCounts: Record<string, number>;
  sampleValues: unknown[];
}

const MAX_SAMPLE_VALUES = 10;

export function aggregateUnmappedFields(extractions: ExtractionResult[]): AggregatedField[] {
  const fieldMap = new Map<
    string,
    {
      observedNames: Set<string>;
      occurrences: number;
      typeCounts: Record<string, number>;
      sampleValues: unknown[];
      sourceExtractionIds: Set<string>;
    }
  >();

  for (const extraction of extractions) {
    const seen = new Set<string>(); // avoid double-counting within one extraction
    for (const field of extraction.metadata.unmappedFields) {
      const normalized = field.name.toLowerCase().replace(/\s+/g, '_');
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      let entry = fieldMap.get(normalized);
      if (!entry) {
        entry = {
          observedNames: new Set<string>(),
          occurrences: 0,
          typeCounts: {},
          sampleValues: [],
          sourceExtractionIds: new Set<string>(),
        };
        fieldMap.set(normalized, entry);
      }

      entry.observedNames.add(field.name);
      entry.occurrences++;
      entry.sourceExtractionIds.add(extraction.id);
      entry.typeCounts[field.suggestedType] = (entry.typeCounts[field.suggestedType] ?? 0) + 1;

      if (entry.sampleValues.length < MAX_SAMPLE_VALUES) {
        entry.sampleValues.push(field.value);
      }
    }
  }

  const totalExtractions = extractions.length;

  return Array.from(fieldMap.entries())
    .map(([normalizedName, entry]) => ({
      normalizedName,
      observedNames: Array.from(entry.observedNames),
      occurrences: entry.occurrences,
      frequency: totalExtractions > 0 ? entry.occurrences / totalExtractions : 0,
      dominantType:
        Object.entries(entry.typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'string',
      typeCounts: entry.typeCounts,
      sampleValues: entry.sampleValues,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/unmapped-aggregator.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/unmapped-aggregator.ts packages/core/tests/unit/evolution/unmapped-aggregator.test.ts
git commit -m "feat(core): add unmapped field aggregator for schema evolution"
```

---

## Task 2: Schema Action Applier

**Files:**

- Create: `packages/core/src/evolution/schema-action-applier.ts`
- Test: `packages/core/tests/unit/evolution/schema-action-applier.test.ts`

Pure function that takes a `SchemaDefinition` + array of `PipelineAction` and produces a new `SchemaDefinition` with the actions applied. Handles: `add_field`, `merge_fields`, `modify_field`, `remove_field`, `rename_field`, `set_normalization_rule`, `update_enum_map`.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { applySchemaActions } from '../../../src/evolution/schema-action-applier.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function makeSchema(fields: SchemaDefinition['fields'] = []): SchemaDefinition {
  return {
    version: 1,
    fields,
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };
}

function makeAddFieldAction(name: string, type: string, required = false): PipelineAction {
  return {
    id: generateId(),
    jobId: 'job-1',
    source: 'schema_evolution',
    type: 'add_field',
    reasoning: `Discovered field ${name}`,
    confidence: 0.9,
    payload: {
      field: { name, description: `The ${name}`, type: type as any, required },
      relevance: {
        globalFrequency: 0.8,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
  } as PipelineAction;
}

describe('applySchemaActions', () => {
  it('applies add_field action', () => {
    const schema = makeSchema([
      { name: 'title', description: 'Title', type: 'string', required: true },
    ]);

    const actions: PipelineAction[] = [makeAddFieldAction('brand', 'string', false)];

    const result = applySchemaActions(schema, actions);

    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[1].name).toBe('brand');
  });

  it('applies remove_field action', () => {
    const schema = makeSchema([
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'temp_field', description: 'Temp', type: 'string', required: false },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'remove_field',
        reasoning: 'Too rare',
        confidence: 0.95,
        payload: { fieldName: 'temp_field', reason: 'too_rare' },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('title');
  });

  it('applies modify_field action', () => {
    const schema = makeSchema([
      { name: 'price', description: 'Price', type: 'string', required: false },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'modify_field',
        reasoning: 'Price should be currency type',
        confidence: 0.9,
        payload: {
          fieldName: 'price',
          changes: { type: 'currency', required: true },
        },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields[0].type).toBe('currency');
    expect(result.fields[0].required).toBe(true);
  });

  it('applies merge_fields action and updates aliases', () => {
    const schema = makeSchema([
      { name: 'retail_price', description: 'Retail price', type: 'currency', required: false },
      { name: 'msrp', description: 'MSRP', type: 'currency', required: false },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'merge_fields',
        reasoning: 'Same concept',
        confidence: 0.85,
        payload: {
          canonicalName: 'price',
          aliasNames: ['retail_price', 'msrp'],
          canonicalDefinition: {
            name: 'price',
            description: 'Product price',
            type: 'currency',
            required: true,
          },
          valueMappings: {},
        },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('price');
    expect(result.fieldAliases).toHaveLength(1);
    expect(result.fieldAliases[0].canonicalName).toBe('price');
    expect(result.fieldAliases[0].aliases).toHaveLength(2);
  });

  it('applies rename_field action', () => {
    const schema = makeSchema([
      { name: 'product_title', description: 'Title', type: 'string', required: true },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'rename_field',
        reasoning: 'Shorter name',
        confidence: 0.9,
        payload: { currentName: 'product_title', newName: 'title', updateExistingData: true },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields[0].name).toBe('title');
  });

  it('applies set_normalization_rule action', () => {
    const schema = makeSchema([
      { name: 'price', description: 'Price', type: 'currency', required: true },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'set_normalization_rule',
        reasoning: 'Standardize currency format',
        confidence: 0.9,
        payload: {
          fieldName: 'price',
          rule: { type: 'currency', config: { targetCurrency: 'USD', decimalPlaces: 2 } },
          examples: [{ before: '$299.99', after: { amount: 299.99, currency: 'USD' } }],
        },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields[0].normalization).toEqual({
      type: 'currency',
      config: { targetCurrency: 'USD', decimalPlaces: 2 },
    });
  });

  it('skips actions for non-existent fields gracefully', () => {
    const schema = makeSchema([
      { name: 'title', description: 'Title', type: 'string', required: true },
    ]);

    const actions: PipelineAction[] = [
      {
        id: generateId(),
        jobId: 'job-1',
        source: 'schema_evolution',
        type: 'remove_field',
        reasoning: 'Stale field',
        confidence: 0.9,
        payload: { fieldName: 'nonexistent', reason: 'too_rare' },
      } as PipelineAction,
    ];

    const result = applySchemaActions(schema, actions);
    expect(result.fields).toHaveLength(1); // no change
  });

  it('does not duplicate fields on add_field', () => {
    const schema = makeSchema([
      { name: 'brand', description: 'Brand', type: 'string', required: false },
    ]);

    const actions: PipelineAction[] = [makeAddFieldAction('brand', 'string', false)];

    const result = applySchemaActions(schema, actions);
    expect(result.fields).toHaveLength(1); // no duplicate
  });

  it('returns unchanged schema for empty actions', () => {
    const schema = makeSchema([
      { name: 'title', description: 'Title', type: 'string', required: true },
    ]);

    const result = applySchemaActions(schema, []);
    expect(result.version).toBe(1); // no version bump
    expect(result.fields).toEqual(schema.fields);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/schema-action-applier.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/schema-action-applier.ts
import { createLogger } from '@spatula/shared';
import type { SchemaDefinition, FieldDefinition, FieldAlias } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';

const logger = createLogger('schema-action-applier');

export function applySchemaActions(
  schema: SchemaDefinition,
  actions: PipelineAction[],
): SchemaDefinition {
  if (actions.length === 0) return schema;

  let fields = [...schema.fields];
  let fieldAliases = [...schema.fieldAliases];
  let changed = false;

  for (const action of actions) {
    const result = applyOne(fields, fieldAliases, action);
    if (result) {
      fields = result.fields;
      fieldAliases = result.fieldAliases;
      changed = true;
    }
  }

  if (!changed) return schema;

  return {
    version: schema.version + 1,
    fields,
    fieldAliases,
    createdAt: new Date(),
    parentVersion: schema.version,
  };
}

function applyOne(
  fields: FieldDefinition[],
  fieldAliases: FieldAlias[],
  action: PipelineAction,
): { fields: FieldDefinition[]; fieldAliases: FieldAlias[] } | null {
  switch (action.type) {
    case 'add_field': {
      const exists = fields.some((f) => f.name === action.payload.field.name);
      if (exists) {
        logger.debug({ field: action.payload.field.name }, 'field already exists, skipping add');
        return null;
      }
      return {
        fields: [...fields, action.payload.field],
        fieldAliases,
      };
    }

    case 'remove_field': {
      const idx = fields.findIndex((f) => f.name === action.payload.fieldName);
      if (idx === -1) {
        logger.debug({ field: action.payload.fieldName }, 'field not found, skipping remove');
        return null;
      }
      return {
        fields: fields.filter((_, i) => i !== idx),
        fieldAliases,
      };
    }

    case 'modify_field': {
      const idx = fields.findIndex((f) => f.name === action.payload.fieldName);
      if (idx === -1) return null;
      const updated = { ...fields[idx] };
      const changes = action.payload.changes;
      if (changes.type) updated.type = changes.type;
      if (changes.required !== undefined) updated.required = changes.required;
      if (changes.description) updated.description = changes.description;
      if (changes.enumValues) updated.enumValues = changes.enumValues;
      const newFields = [...fields];
      newFields[idx] = updated;
      return { fields: newFields, fieldAliases };
    }

    case 'rename_field': {
      const idx = fields.findIndex((f) => f.name === action.payload.currentName);
      if (idx === -1) return null;
      const newFields = [...fields];
      newFields[idx] = { ...newFields[idx], name: action.payload.newName };
      return { fields: newFields, fieldAliases };
    }

    case 'merge_fields': {
      const mergedNames = new Set(action.payload.aliasNames);
      const remaining = fields.filter((f) => !mergedNames.has(f.name));
      const alias: FieldAlias = {
        canonicalName: action.payload.canonicalName,
        aliases: action.payload.aliasNames.map((name) => ({
          name,
          sources: [],
          occurrences: 0,
        })),
        mergedAt: new Date(),
        reasoning: action.reasoning,
      };
      return {
        fields: [...remaining, action.payload.canonicalDefinition],
        fieldAliases: [...fieldAliases, alias],
      };
    }

    case 'set_normalization_rule': {
      const idx = fields.findIndex((f) => f.name === action.payload.fieldName);
      if (idx === -1) return null;
      const newFields = [...fields];
      newFields[idx] = { ...newFields[idx], normalization: action.payload.rule };
      return { fields: newFields, fieldAliases };
    }

    case 'update_enum_map': {
      const idx = fields.findIndex((f) => f.name === action.payload.fieldName);
      if (idx === -1) return null;
      const field = fields[idx];
      if (field.type !== 'enum' || !field.normalization || field.normalization.type !== 'enum')
        return null;
      const existingMap = field.normalization.config.synonymMap;
      const newFields = [...fields];
      newFields[idx] = {
        ...field,
        normalization: {
          ...field.normalization,
          config: {
            ...field.normalization.config,
            synonymMap: { ...existingMap, ...action.payload.additions },
            canonicalValues:
              action.payload.newCanonicalValues ?? field.normalization.config.canonicalValues,
          },
        },
      };
      return { fields: newFields, fieldAliases };
    }

    default:
      logger.debug({ type: action.type }, 'unhandled action type in schema applier');
      return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/schema-action-applier.test.ts`
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/schema-action-applier.ts packages/core/tests/unit/evolution/schema-action-applier.test.ts
git commit -m "feat(core): add schema action applier for evolution pipeline"
```

---

## Task 3: LLM Field Proposer

**Files:**

- Create: `packages/core/src/evolution/field-proposer.ts`
- Test: `packages/core/tests/unit/evolution/field-proposer.test.ts`

Uses the LLM to analyze aggregated unmapped fields and current schema, then proposes `add_field` actions with proper `FieldRelevance` and `FieldDefinition`.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FieldProposer } from '../../../src/evolution/field-proposer.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { AggregatedField } from '../../../src/evolution/unmapped-aggregator.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

function mockLLMClient(response: object): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify(response),
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

function makeSchema(): SchemaDefinition {
  return {
    version: 1,
    fields: [
      { name: 'title', description: 'Product title', type: 'string', required: true },
      { name: 'price', description: 'Product price', type: 'currency', required: true },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };
}

describe('FieldProposer', () => {
  it('proposes add_field actions from unmapped fields', async () => {
    const llmResponse = {
      proposals: [
        {
          name: 'brand',
          description: 'Product brand or manufacturer',
          type: 'string',
          required: false,
          reasoning: 'Brand appears in 80% of extractions',
          confidence: 0.85,
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      ],
    };

    const proposer = new FieldProposer(mockLLMClient(llmResponse), {
      primaryModel: 'test-model',
    });

    const aggregated: AggregatedField[] = [
      {
        normalizedName: 'brand',
        observedNames: ['brand', 'Brand_Name'],
        occurrences: 8,
        frequency: 0.8,
        dominantType: 'string',
        typeCounts: { string: 8 },
        sampleValues: ['Sennheiser', 'Audio-Technica', 'Beyerdynamic'],
      },
    ];

    const actions = await proposer.propose(makeSchema(), aggregated, 'audiophile products');

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('add_field');
    expect(actions[0].source).toBe('schema_evolution');
    expect(actions[0].payload.field.name).toBe('brand');
    expect(actions[0].payload.relevance.classification).toBe('universal_optional');
  });

  it('skips fields already in schema', async () => {
    const proposer = new FieldProposer(mockLLMClient({ proposals: [] }), {
      primaryModel: 'test-model',
    });

    const aggregated: AggregatedField[] = [
      {
        normalizedName: 'title',
        observedNames: ['title'],
        occurrences: 10,
        frequency: 1.0,
        dominantType: 'string',
        typeCounts: { string: 10 },
        sampleValues: ['Product 1'],
      },
    ];

    const actions = await proposer.propose(makeSchema(), aggregated, 'products');
    expect(actions).toHaveLength(0);
  });

  it('returns empty on LLM parse error', async () => {
    const badClient: LLMClient = {
      complete: vi.fn().mockResolvedValue({
        content: 'not json',
        model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      }),
    };

    const proposer = new FieldProposer(badClient, { primaryModel: 'test' });
    const actions = await proposer.propose(
      makeSchema(),
      [
        {
          normalizedName: 'brand',
          observedNames: ['brand'],
          occurrences: 5,
          frequency: 0.5,
          dominantType: 'string',
          typeCounts: { string: 5 },
          sampleValues: ['x'],
        },
      ],
      'products',
    );

    expect(actions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/field-proposer.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/field-proposer.ts
import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';
import { FieldRelevance } from '../types/schema.js';
import type { AggregatedField } from './unmapped-aggregator.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('field-proposer');

const FieldProposal = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  relevance: FieldRelevance,
});

const LLMFieldProposalResponse = z.object({
  proposals: z.array(FieldProposal),
});

export class FieldProposer {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async propose(
    currentSchema: SchemaDefinition,
    aggregatedFields: AggregatedField[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    const existingNames = new Set(currentSchema.fields.map((f) => f.name));
    const candidates = aggregatedFields.filter((f) => !existingNames.has(f.normalizedName));

    if (candidates.length === 0) return [];

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'schemaEvolution'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildProposalPrompt(currentSchema, candidates, jobDescription) },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      let parsed: z.infer<typeof LLMFieldProposalResponse>;
      try {
        parsed = LLMFieldProposalResponse.parse(JSON.parse(response.content));
      } catch (parseError) {
        logger.warn({ parseError }, 'invalid field proposal response from LLM');
        return [];
      }

      return parsed.proposals
        .filter((p) => !existingNames.has(p.name))
        .map(
          (proposal): PipelineAction => ({
            id: generateId(),
            jobId: '', // caller fills in
            source: 'schema_evolution',
            type: 'add_field',
            reasoning: proposal.reasoning,
            confidence: proposal.confidence,
            payload: {
              field: {
                name: proposal.name,
                description: proposal.description,
                type: proposal.type,
                required: proposal.required,
                ...(proposal.enumValues ? { enumValues: proposal.enumValues } : {}),
              },
              relevance: proposal.relevance,
            },
          }),
        );
    } catch (error) {
      logger.error({ error }, 'field proposal LLM call failed');
      return [];
    }
  }
}

const SYSTEM_PROMPT = `You are a schema evolution expert. Given unmapped fields discovered during web crawling and the current extraction schema, propose new fields to add. Return JSON only.

Guidelines:
- Only propose fields genuinely relevant to the data collection goal
- Prefer clear, snake_case names
- Set appropriate types based on observed values
- Set required=true only for fields appearing in >85% of extractions
- Evaluate field relevance both globally and per-category
- Do NOT propose fields that duplicate existing schema fields (even under a different name — that's a merge, not an add)`;

function buildProposalPrompt(
  schema: SchemaDefinition,
  candidates: AggregatedField[],
  jobDescription: string,
): string {
  const existingFields = schema.fields
    .map((f) => `- ${f.name} (${f.type}): ${f.description}`)
    .join('\n');

  const candidateLines = candidates
    .map(
      (c) =>
        `- "${c.normalizedName}" (observed as: ${c.observedNames.join(', ')})
    Type: ${c.dominantType} | Frequency: ${(c.frequency * 100).toFixed(0)}% (${c.occurrences} occurrences)
    Sample values: ${c.sampleValues
      .slice(0, 5)
      .map((v) => JSON.stringify(v))
      .join(', ')}`,
    )
    .join('\n');

  return `## Data Collection Goal
${jobDescription}

## Current Schema (v${schema.version})
${existingFields}

## Unmapped Fields Discovered
${candidateLines}

## Instructions
Analyze each unmapped field and decide whether to propose it as a new schema field.
For each proposed field, provide:
- A clean snake_case name
- Description
- Correct type based on sample values
- Whether it should be required
- Field relevance classification (universal_required, universal_optional, categorical_required, categorical_optional, rare)
- Your confidence in the proposal (0.0-1.0)

Return JSON:
{
  "proposals": [
    {
      "name": "field_name",
      "description": "What this field represents",
      "type": "string",
      "required": false,
      "enumValues": ["optional", "for", "enums"],
      "reasoning": "Why this field should be added",
      "confidence": 0.85,
      "relevance": {
        "globalFrequency": 0.8,
        "categoryBreakdown": [{"category": "headphones", "frequency": 0.95, "sampleSize": 20}],
        "classification": "universal_optional",
        "applicableCategories": null
      }
    }
  ]
}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/field-proposer.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/field-proposer.ts packages/core/tests/unit/evolution/field-proposer.test.ts
git commit -m "feat(core): add LLM-powered field proposer for schema evolution"
```

---

## Task 4: LLM Synonym Detector

**Files:**

- Create: `packages/core/src/evolution/synonym-detector.ts`
- Test: `packages/core/tests/unit/evolution/synonym-detector.test.ts`

Uses the LLM to detect field synonyms between current schema fields and new/unmapped fields, proposing `merge_fields` actions.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SynonymDetector } from '../../../src/evolution/synonym-detector.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { AggregatedField } from '../../../src/evolution/unmapped-aggregator.js';

function mockLLMClient(response: object): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify(response),
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

function makeSchema(): SchemaDefinition {
  return {
    version: 2,
    fields: [
      { name: 'title', description: 'Product title', type: 'string', required: true },
      { name: 'retail_price', description: 'Retail price', type: 'currency', required: false },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: 1,
  };
}

describe('SynonymDetector', () => {
  it('detects synonym pairs and proposes merge_fields', async () => {
    const llmResponse = {
      merges: [
        {
          canonicalName: 'price',
          aliasNames: ['retail_price', 'msrp'],
          canonicalDefinition: {
            name: 'price',
            description: 'Product price',
            type: 'currency',
            required: true,
          },
          reasoning: 'retail_price and msrp represent the same concept',
          confidence: 0.88,
        },
      ],
    };

    const detector = new SynonymDetector(mockLLMClient(llmResponse), { primaryModel: 'test' });

    const aggregated: AggregatedField[] = [
      {
        normalizedName: 'msrp',
        observedNames: ['msrp', 'MSRP'],
        occurrences: 6,
        frequency: 0.6,
        dominantType: 'currency',
        typeCounts: { currency: 6 },
        sampleValues: ['$299', '$199'],
      },
    ];

    const actions = await detector.detect(makeSchema(), aggregated, 'audiophile products');

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('merge_fields');
    expect(actions[0].payload.canonicalName).toBe('price');
    expect(actions[0].payload.aliasNames).toContain('retail_price');
    expect(actions[0].payload.aliasNames).toContain('msrp');
  });

  it('returns empty on no synonyms found', async () => {
    const detector = new SynonymDetector(mockLLMClient({ merges: [] }), { primaryModel: 'test' });

    const actions = await detector.detect(makeSchema(), [], 'products');
    expect(actions).toHaveLength(0);
  });

  it('returns empty on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const detector = new SynonymDetector(client, { primaryModel: 'test' });
    const actions = await detector.detect(makeSchema(), [], 'products');
    expect(actions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/synonym-detector.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/synonym-detector.ts
import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { PipelineAction } from '../types/actions.js';
import { FieldDefinition } from '../types/schema.js';
import type { AggregatedField } from './unmapped-aggregator.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('synonym-detector');

const MergeProposal = z.object({
  canonicalName: z.string(),
  aliasNames: z.array(z.string()),
  canonicalDefinition: FieldDefinition,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const LLMSynonymResponse = z.object({
  merges: z.array(MergeProposal),
});

export class SynonymDetector {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async detect(
    currentSchema: SchemaDefinition,
    aggregatedFields: AggregatedField[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    const allFieldNames = [
      ...currentSchema.fields.map((f) => f.name),
      ...aggregatedFields.map((f) => f.normalizedName),
    ];

    if (allFieldNames.length < 2) return [];

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'schemaEvolution'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildSynonymPrompt(currentSchema, aggregatedFields, jobDescription),
          },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      let parsed: z.infer<typeof LLMSynonymResponse>;
      try {
        parsed = LLMSynonymResponse.parse(JSON.parse(response.content));
      } catch (parseError) {
        logger.warn({ parseError }, 'invalid synonym detection response');
        return [];
      }

      return parsed.merges.map(
        (merge): PipelineAction => ({
          id: generateId(),
          jobId: '',
          source: 'schema_evolution',
          type: 'merge_fields',
          reasoning: merge.reasoning,
          confidence: merge.confidence,
          payload: {
            canonicalName: merge.canonicalName,
            aliasNames: merge.aliasNames,
            canonicalDefinition: merge.canonicalDefinition,
            valueMappings: {},
          },
        }),
      );
    } catch (error) {
      logger.error({ error }, 'synonym detection failed');
      return [];
    }
  }
}

const SYSTEM_PROMPT = `You are a field synonym detection expert. Given schema fields and newly discovered unmapped fields from web crawling, identify fields that represent the same concept under different names. Return JSON only.

Guidelines:
- Only merge fields you are confident represent the same data (>80% confidence)
- Choose the clearest, most descriptive canonical name
- The canonical definition should use the best type for the merged concept
- Consider domain context when evaluating synonyms (e.g., "msrp" and "retail_price" are synonyms for price)`;

function buildSynonymPrompt(
  schema: SchemaDefinition,
  aggregated: AggregatedField[],
  jobDescription: string,
): string {
  const schemaFields = schema.fields
    .map((f) => `- ${f.name} (${f.type}): ${f.description}`)
    .join('\n');

  const unmappedFields = aggregated
    .map(
      (f) =>
        `- "${f.normalizedName}" (observed as: ${f.observedNames.join(', ')}, type: ${f.dominantType}, freq: ${(f.frequency * 100).toFixed(0)}%)
    Samples: ${f.sampleValues
      .slice(0, 3)
      .map((v) => JSON.stringify(v))
      .join(', ')}`,
    )
    .join('\n');

  return `## Data Collection Goal
${jobDescription}

## Current Schema Fields
${schemaFields || '(empty)'}

## Newly Discovered Unmapped Fields
${unmappedFields || '(none)'}

## Instructions
Identify any synonym pairs between schema fields AND/OR unmapped fields.
Only propose merges when you are confident the fields represent the same concept.

Return JSON:
{
  "merges": [
    {
      "canonicalName": "price",
      "aliasNames": ["retail_price", "msrp"],
      "canonicalDefinition": {
        "name": "price",
        "description": "Product price",
        "type": "currency",
        "required": true
      },
      "reasoning": "Both represent the selling price of the product",
      "confidence": 0.9
    }
  ]
}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/synonym-detector.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/synonym-detector.ts packages/core/tests/unit/evolution/synonym-detector.test.ts
git commit -m "feat(core): add LLM-powered synonym detector for schema evolution"
```

---

## Task 5: LLM Normalization Proposer

**Files:**

- Create: `packages/core/src/evolution/normalization-proposer.ts`
- Test: `packages/core/tests/unit/evolution/normalization-proposer.test.ts`

Uses the LLM to analyze extracted values and propose `set_normalization_rule` and `update_enum_map` actions.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NormalizationProposer } from '../../../src/evolution/normalization-proposer.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

function mockLLMClient(response: object): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify(response),
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

function makeSchema(): SchemaDefinition {
  return {
    version: 1,
    fields: [
      { name: 'price', description: 'Price', type: 'currency', required: true },
      {
        name: 'device_type',
        description: 'Type of device',
        type: 'enum',
        required: true,
        enumValues: ['headphone', 'amplifier'],
      },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };
}

function makeExtractions(): ExtractionResult[] {
  return [
    {
      id: 'ext-1',
      jobId: 'job-1',
      pageId: 'p-1',
      schemaVersion: 1,
      data: { price: '$299.99', device_type: 'Headphones' },
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [],
      },
    },
    {
      id: 'ext-2',
      jobId: 'job-1',
      pageId: 'p-2',
      schemaVersion: 1,
      data: { price: '€199', device_type: 'headphone amp' },
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [],
      },
    },
  ];
}

describe('NormalizationProposer', () => {
  it('proposes normalization rules for fields with inconsistent values', async () => {
    const llmResponse = {
      rules: [
        {
          fieldName: 'price',
          rule: { type: 'currency', config: { targetCurrency: 'USD', decimalPlaces: 2 } },
          examples: [
            { before: '$299.99', after: { amount: 299.99, currency: 'USD' } },
            { before: '€199', after: { amount: 199, currency: 'EUR' } },
          ],
          reasoning: 'Standardize currency format',
          confidence: 0.9,
        },
      ],
      enumUpdates: [
        {
          fieldName: 'device_type',
          additions: { Headphones: 'headphone', 'headphone amp': 'amplifier' },
          newCanonicalValues: ['headphone', 'amplifier', 'dac'],
          reasoning: 'Canonicalize device type values',
          confidence: 0.85,
        },
      ],
    };

    const proposer = new NormalizationProposer(mockLLMClient(llmResponse), {
      primaryModel: 'test',
    });

    const actions = await proposer.propose(makeSchema(), makeExtractions(), 'audiophile products');

    expect(actions).toHaveLength(2);

    const normAction = actions.find((a) => a.type === 'set_normalization_rule');
    expect(normAction).toBeDefined();
    expect(normAction!.payload.fieldName).toBe('price');

    const enumAction = actions.find((a) => a.type === 'update_enum_map');
    expect(enumAction).toBeDefined();
    expect(enumAction!.payload.fieldName).toBe('device_type');
  });

  it('returns empty on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const proposer = new NormalizationProposer(client, { primaryModel: 'test' });
    const actions = await proposer.propose(makeSchema(), makeExtractions(), 'products');
    expect(actions).toHaveLength(0);
  });

  it('skips fields that already have normalization rules', async () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        {
          name: 'price',
          description: 'Price',
          type: 'currency',
          required: true,
          normalization: { type: 'currency', config: { targetCurrency: 'USD', decimalPlaces: 2 } },
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };

    const proposer = new NormalizationProposer(mockLLMClient({ rules: [], enumUpdates: [] }), {
      primaryModel: 'test',
    });

    const actions = await proposer.propose(schema, makeExtractions(), 'products');
    // The LLM should not even be asked about pre-normalized fields
    // (they're filtered from the prompt)
    expect(actions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/normalization-proposer.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/normalization-proposer.ts
import { z } from 'zod';
import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';
import { NormalizationRule } from '../types/normalization.js';
import { resolveModel } from '../llm/model-router.js';

const logger = createLogger('normalization-proposer');

const NormRuleProposal = z.object({
  fieldName: z.string(),
  rule: NormalizationRule,
  examples: z.array(z.object({ before: z.unknown(), after: z.unknown() })),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const EnumUpdateProposal = z.object({
  fieldName: z.string(),
  additions: z.record(z.string()),
  newCanonicalValues: z.array(z.string()).optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const LLMNormalizationResponse = z.object({
  rules: z.array(NormRuleProposal),
  enumUpdates: z.array(EnumUpdateProposal),
});

export class NormalizationProposer {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async propose(
    schema: SchemaDefinition,
    extractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    const fieldsNeedingNorm = schema.fields.filter((f) => !f.normalization);
    if (fieldsNeedingNorm.length === 0) return [];

    const valueSamples = collectValueSamples(
      fieldsNeedingNorm.map((f) => f.name),
      extractions,
    );
    if (Object.keys(valueSamples).length === 0) return [];

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'schemaEvolution'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildNormPrompt(schema, valueSamples, jobDescription) },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      let parsed: z.infer<typeof LLMNormalizationResponse>;
      try {
        parsed = LLMNormalizationResponse.parse(JSON.parse(response.content));
      } catch (parseError) {
        logger.warn({ parseError }, 'invalid normalization proposal response');
        return [];
      }

      const actions: PipelineAction[] = [];

      for (const rule of parsed.rules) {
        actions.push({
          id: generateId(),
          jobId: '',
          source: 'schema_evolution',
          type: 'set_normalization_rule',
          reasoning: rule.reasoning,
          confidence: rule.confidence,
          payload: {
            fieldName: rule.fieldName,
            rule: rule.rule,
            examples: rule.examples,
          },
        } as PipelineAction);
      }

      for (const update of parsed.enumUpdates) {
        actions.push({
          id: generateId(),
          jobId: '',
          source: 'schema_evolution',
          type: 'update_enum_map',
          reasoning: update.reasoning,
          confidence: update.confidence,
          payload: {
            fieldName: update.fieldName,
            additions: update.additions,
            newCanonicalValues: update.newCanonicalValues,
          },
        } as PipelineAction);
      }

      return actions;
    } catch (error) {
      logger.error({ error }, 'normalization proposal failed');
      return [];
    }
  }
}

function collectValueSamples(
  fieldNames: string[],
  extractions: ExtractionResult[],
): Record<string, unknown[]> {
  const samples: Record<string, unknown[]> = {};

  for (const extraction of extractions) {
    for (const name of fieldNames) {
      if (extraction.data[name] !== undefined) {
        if (!samples[name]) samples[name] = [];
        if (samples[name].length < 10) {
          samples[name].push(extraction.data[name]);
        }
      }
    }
  }

  return samples;
}

const SYSTEM_PROMPT = `You are a data normalization expert. Analyze extracted field values and propose normalization rules to standardize them. Return JSON only.

Guidelines:
- Only propose rules where values are genuinely inconsistent
- For enum fields, propose synonym mappings to canonical values
- For currency fields, suggest a standard currency format
- For text fields, suggest casing/whitespace rules only if needed
- Include clear before/after examples`;

function buildNormPrompt(
  schema: SchemaDefinition,
  valueSamples: Record<string, unknown[]>,
  jobDescription: string,
): string {
  const fieldInfo = schema.fields
    .filter((f) => !f.normalization && valueSamples[f.name])
    .map(
      (f) =>
        `- ${f.name} (${f.type}${f.enumValues ? `, enums: [${f.enumValues.join(', ')}]` : ''}):
    Values: ${valueSamples[f.name]?.map((v) => JSON.stringify(v)).join(', ') ?? '(none)'}`,
    )
    .join('\n');

  return `## Data Collection Goal
${jobDescription}

## Fields and Observed Values
${fieldInfo}

## Instructions
For each field with inconsistent values, propose:
1. A normalization rule (currency, enum, text, measurement, boolean, or list type)
2. For enum fields: synonym mappings (observed value → canonical value)

Return JSON:
{
  "rules": [
    {
      "fieldName": "price",
      "rule": { "type": "currency", "config": { "targetCurrency": "USD", "decimalPlaces": 2 } },
      "examples": [{ "before": "$299.99", "after": { "amount": 299.99, "currency": "USD" } }],
      "reasoning": "Standardize currency format",
      "confidence": 0.9
    }
  ],
  "enumUpdates": [
    {
      "fieldName": "device_type",
      "additions": { "Headphones": "headphone", "HP": "headphone" },
      "newCanonicalValues": ["headphone", "amplifier"],
      "reasoning": "Map observed variants to canonical values",
      "confidence": 0.85
    }
  ]
}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/normalization-proposer.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/normalization-proposer.ts packages/core/tests/unit/evolution/normalization-proposer.test.ts
git commit -m "feat(core): add LLM-powered normalization proposer for schema evolution"
```

---

## Task 6: SchemaEvolverImpl — Full Pipeline Orchestrator

**Files:**

- Create: `packages/core/src/evolution/schema-evolver-impl.ts`
- Create: `packages/core/src/evolution/index.ts`
- Modify: `packages/core/src/extraction/index.ts` (add evolution exports)
- Test: `packages/core/tests/unit/evolution/schema-evolver-impl.test.ts`

Orchestrates the full evolution pipeline: aggregate → propose fields → detect synonyms → propose normalization → return all actions. Implements the existing `SchemaEvolver` interface.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchemaEvolverImpl } from '../../../src/evolution/schema-evolver-impl.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

function makeMockLLMClient(): LLMClient {
  let callCount = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      callCount++;
      // Call 1: field proposals, Call 2: synonym detection, Call 3: normalization
      if (callCount === 1) {
        return Promise.resolve({
          content: JSON.stringify({
            proposals: [
              {
                name: 'brand',
                description: 'Product brand',
                type: 'string',
                required: false,
                reasoning: 'Common across extractions',
                confidence: 0.9,
                relevance: {
                  globalFrequency: 0.8,
                  categoryBreakdown: [],
                  classification: 'universal_optional',
                  applicableCategories: null,
                },
              },
            ],
          }),
          model: 'test',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        });
      }
      if (callCount === 2) {
        return Promise.resolve({
          content: JSON.stringify({ merges: [] }),
          model: 'test',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        });
      }
      return Promise.resolve({
        content: JSON.stringify({ rules: [], enumUpdates: [] }),
        model: 'test',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      });
    }),
  };
}

function makeSchema(): SchemaDefinition {
  return {
    version: 1,
    fields: [{ name: 'title', description: 'Product title', type: 'string', required: true }],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };
}

function makeExtractions(): ExtractionResult[] {
  return [
    {
      id: 'ext-1',
      jobId: 'job-1',
      pageId: 'p-1',
      schemaVersion: 1,
      data: { title: 'HD 600' },
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [{ name: 'brand', value: 'Sennheiser', suggestedType: 'string' }],
      },
    },
    {
      id: 'ext-2',
      jobId: 'job-1',
      pageId: 'p-2',
      schemaVersion: 1,
      data: { title: 'DT 770 Pro' },
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [{ name: 'brand', value: 'Beyerdynamic', suggestedType: 'string' }],
      },
    },
  ];
}

describe('SchemaEvolverImpl', () => {
  it('returns add_field actions from the full pipeline', async () => {
    const evolver = new SchemaEvolverImpl(makeMockLLMClient(), { primaryModel: 'test' });

    const actions = await evolver.evolve(makeSchema(), makeExtractions(), 'audiophile products');

    expect(actions.length).toBeGreaterThanOrEqual(1);
    const addActions = actions.filter((a) => a.type === 'add_field');
    expect(addActions).toHaveLength(1);
    expect(addActions[0].payload.field.name).toBe('brand');
  });

  it('returns empty when no unmapped fields', async () => {
    const extractions: ExtractionResult[] = [
      {
        id: 'ext-1',
        jobId: 'job-1',
        pageId: 'p-1',
        schemaVersion: 1,
        data: { title: 'HD 600' },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
      },
    ];

    const evolver = new SchemaEvolverImpl(makeMockLLMClient(), { primaryModel: 'test' });
    const actions = await evolver.evolve(makeSchema(), extractions, 'products');

    // No unmapped fields means no field proposals, but may still get synonym/norm proposals
    // from existing schema fields
    expect(Array.isArray(actions)).toBe(true);
  });

  it('combines actions from all sub-analyzers', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: JSON.stringify({
              proposals: [
                {
                  name: 'brand',
                  description: 'Brand',
                  type: 'string',
                  required: false,
                  reasoning: 'Found in data',
                  confidence: 0.9,
                  relevance: {
                    globalFrequency: 0.8,
                    categoryBreakdown: [],
                    classification: 'universal_optional',
                    applicableCategories: null,
                  },
                },
              ],
            }),
            model: 'test',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
          });
        }
        if (callCount === 2) {
          return Promise.resolve({
            content: JSON.stringify({
              merges: [
                {
                  canonicalName: 'name',
                  aliasNames: ['title', 'product_name'],
                  canonicalDefinition: {
                    name: 'name',
                    description: 'Name',
                    type: 'string',
                    required: true,
                  },
                  reasoning: 'Same field',
                  confidence: 0.85,
                },
              ],
            }),
            model: 'test',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
          });
        }
        return Promise.resolve({
          content: JSON.stringify({ rules: [], enumUpdates: [] }),
          model: 'test',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        });
      }),
    };

    const evolver = new SchemaEvolverImpl(client, { primaryModel: 'test' });
    const actions = await evolver.evolve(makeSchema(), makeExtractions(), 'products');

    const types = new Set(actions.map((a) => a.type));
    expect(types.has('add_field')).toBe(true);
    expect(types.has('merge_fields')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/evolution/schema-evolver-impl.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/evolution/schema-evolver-impl.ts
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';
import type { SchemaEvolver } from '../interfaces/schema-evolver.js';
import { aggregateUnmappedFields } from './unmapped-aggregator.js';
import { FieldProposer } from './field-proposer.js';
import { SynonymDetector } from './synonym-detector.js';
import { NormalizationProposer } from './normalization-proposer.js';

const logger = createLogger('schema-evolver');

export class SchemaEvolverImpl implements SchemaEvolver {
  private readonly fieldProposer: FieldProposer;
  private readonly synonymDetector: SynonymDetector;
  private readonly normalizationProposer: NormalizationProposer;

  constructor(llmClient: LLMClient, config: LLMConfig) {
    this.fieldProposer = new FieldProposer(llmClient, config);
    this.synonymDetector = new SynonymDetector(llmClient, config);
    this.normalizationProposer = new NormalizationProposer(llmClient, config);
  }

  async evolve(
    currentSchema: SchemaDefinition,
    recentExtractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]> {
    logger.info(
      { schemaVersion: currentSchema.version, extractionCount: recentExtractions.length },
      'starting schema evolution',
    );

    const aggregated = aggregateUnmappedFields(recentExtractions);
    logger.debug({ unmappedFieldCount: aggregated.length }, 'unmapped fields aggregated');

    // Run all three analysis phases
    // Field proposals and synonym detection can use aggregated unmapped fields
    // Normalization uses the extracted data values
    const [fieldActions, synonymActions, normActions] = await Promise.all([
      this.fieldProposer.propose(currentSchema, aggregated, jobDescription),
      this.synonymDetector.detect(currentSchema, aggregated, jobDescription),
      this.normalizationProposer.propose(currentSchema, recentExtractions, jobDescription),
    ]);

    const allActions = [...fieldActions, ...synonymActions, ...normActions];

    logger.info(
      {
        fieldProposals: fieldActions.length,
        synonymMerges: synonymActions.length,
        normRules: normActions.length,
        totalActions: allActions.length,
      },
      'schema evolution complete',
    );

    return allActions;
  }
}
```

```typescript
// packages/core/src/evolution/index.ts
export { aggregateUnmappedFields } from './unmapped-aggregator.js';
export type { AggregatedField } from './unmapped-aggregator.js';
export { applySchemaActions } from './schema-action-applier.js';
export { FieldProposer } from './field-proposer.js';
export { SynonymDetector } from './synonym-detector.js';
export { NormalizationProposer } from './normalization-proposer.js';
export { SchemaEvolverImpl } from './schema-evolver-impl.js';
```

Update `packages/core/src/index.ts` to add:

```typescript
// Evolution
export * from './evolution/index.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/unit/evolution/schema-evolver-impl.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/core/src/evolution/ packages/core/src/index.ts packages/core/tests/unit/evolution/schema-evolver-impl.test.ts
git commit -m "feat(core): add SchemaEvolverImpl orchestrating full evolution pipeline"
```

---

## Task 7: Schema Evolution Worker Implementation

**Files:**

- Modify: `packages/queue/src/workers/schema-worker.ts` (replace stub)
- Modify: `packages/queue/src/worker-deps.ts` (add `schemaEvolver`)
- Test: `packages/queue/tests/unit/workers/schema-worker.test.ts` (rewrite from stub tests)

Complete the schema worker to: load job config, fetch recent extractions by IDs, call `SchemaEvolver.evolve()`, apply auto-approved actions, persist new schema version.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSchemaEvolutionJob } from '../../../src/workers/schema-worker.js';
import type { SchemaEvolutionJobData } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';

function createMockDeps(): WorkerDeps {
  const mockJob = {
    id: 'job-1',
    tenantId: 'tenant-1',
    status: 'running',
    config: {
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Audiophile products',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 3, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: {
        mode: 'discovery',
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
          tableStrategy: 'auto',
        },
      },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    },
  };

  const mockSchema = {
    id: 'schema-1',
    jobId: 'job-1',
    tenantId: 'tenant-1',
    version: 1,
    definition: {
      version: 1,
      fields: [{ name: 'title', description: 'Product title', type: 'string', required: true }],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    },
    parentId: null,
    createdAt: new Date(),
  };

  const mockExtractions = [
    {
      id: 'ext-1',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      pageId: 'p-1',
      schemaVersion: 1,
      data: { title: 'HD 600' },
      unmappedFields: [{ name: 'brand', value: 'Sennheiser', suggestedType: 'string' }],
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [{ name: 'brand', value: 'Sennheiser', suggestedType: 'string' }],
      },
      createdAt: new Date(),
    },
    {
      id: 'ext-2',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      pageId: 'p-2',
      schemaVersion: 1,
      data: { title: 'DT 770' },
      unmappedFields: [{ name: 'brand', value: 'Beyerdynamic', suggestedType: 'string' }],
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [{ name: 'brand', value: 'Beyerdynamic', suggestedType: 'string' }],
      },
      createdAt: new Date(),
    },
  ];

  const addFieldAction = {
    id: 'action-1',
    jobId: 'job-1',
    source: 'schema_evolution',
    type: 'add_field',
    reasoning: 'Brand found in data',
    confidence: 0.9,
    payload: {
      field: { name: 'brand', description: 'Product brand', type: 'string', required: false },
      relevance: {
        globalFrequency: 0.8,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
  };

  return {
    crawler: { type: 'playwright', crawl: vi.fn(), close: vi.fn() } as any,
    classifier: { classify: vi.fn() } as any,
    extractor: { extract: vi.fn() } as any,
    contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() } as any,
    jobRepo: {
      findById: vi.fn().mockResolvedValue(mockJob),
    } as any,
    taskRepo: {
      updateStatus: vi.fn(),
      updateClassification: vi.fn(),
      enqueue: vi.fn(),
    } as any,
    pageRepo: {
      findByContentHash: vi.fn(),
      create: vi.fn(),
    } as any,
    extractionRepo: {
      store: vi.fn(),
      findByJob: vi.fn().mockResolvedValue(mockExtractions),
      findByPage: vi.fn(),
    } as any,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(mockSchema),
      create: vi.fn().mockResolvedValue({ id: 'schema-2' }),
      findByVersion: vi.fn(),
      findAllVersions: vi.fn(),
    } as any,
    queues: {
      crawl: { add: vi.fn() },
      extract: { add: vi.fn() },
      schemaEvolution: { add: vi.fn() },
      closeAll: vi.fn(),
    } as any,
    schemaEvolver: {
      evolve: vi.fn().mockResolvedValue([addFieldAction]),
    } as any,
  } as unknown as WorkerDeps;
}

describe('processSchemaEvolutionJob', () => {
  let deps: WorkerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('fetches job, schema, extractions and calls evolve()', async () => {
    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1', 'ext-2'],
    };

    await processSchemaEvolutionJob(data, deps);

    expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', 'tenant-1');
    expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith('job-1', 'tenant-1');
    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
      'job-1',
      'tenant-1',
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    expect(deps.schemaEvolver.evolve).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      expect.arrayContaining([expect.objectContaining({ id: 'ext-1' })]),
      'Audiophile products',
    );
  });

  it('creates new schema version when actions are produced', async () => {
    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1', 'ext-2'],
    };

    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        version: 2,
        parentId: 'schema-1',
      }),
    );
  });

  it('skips when evolution is disabled', async () => {
    const disabledJob = {
      id: 'job-1',
      tenantId: 'tenant-1',
      status: 'running',
      config: {
        tenantId: 'tenant-1',
        name: 'Test',
        description: 'Test',
        seedUrls: [],
        crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
        schema: { mode: 'fixed' },
        llm: { primaryModel: 'test' },
      },
    };
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(disabledJob);

    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1'],
    };

    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips when no schema exists yet', async () => {
    (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1'],
    };

    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
  });

  it('skips schema creation when no actions returned', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1'],
    };

    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('handles errors gracefully without crashing', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('LLM down'),
    );

    const data: SchemaEvolutionJobData = {
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: ['ext-1'],
    };

    // Should not throw
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/workers/schema-worker.test.ts`
Expected: FAIL — `schemaEvolver` not on `WorkerDeps`, new function signature

**Step 3: Write minimal implementation**

Update `packages/queue/src/worker-deps.ts`:

```typescript
import type { Crawler, Extractor, ContentStore, SchemaEvolver } from '@spatula/core';
import type { PageClassifier } from '@spatula/core';
import type {
  JobRepository,
  CrawlTaskRepository,
  PageRepository,
  ExtractionRepository,
  SchemaRepository,
} from '@spatula/db';
import type { SpatulaQueues } from './queues.js';

export interface WorkerDepsConfig {
  crawler: Crawler;
  extractor: Extractor;
  classifier: PageClassifier;
  contentStore: ContentStore;
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  pageRepo: PageRepository;
  extractionRepo: ExtractionRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
  schemaEvolver: SchemaEvolver;
}

export class WorkerDeps {
  readonly crawler: Crawler;
  readonly extractor: Extractor;
  readonly classifier: PageClassifier;
  readonly contentStore: ContentStore;
  readonly jobRepo: JobRepository;
  readonly taskRepo: CrawlTaskRepository;
  readonly pageRepo: PageRepository;
  readonly extractionRepo: ExtractionRepository;
  readonly schemaRepo: SchemaRepository;
  readonly queues: SpatulaQueues;
  readonly schemaEvolver: SchemaEvolver;

  constructor(config: WorkerDepsConfig) {
    this.crawler = config.crawler;
    this.extractor = config.extractor;
    this.classifier = config.classifier;
    this.contentStore = config.contentStore;
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.pageRepo = config.pageRepo;
    this.extractionRepo = config.extractionRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
    this.schemaEvolver = config.schemaEvolver;
  }
}
```

Replace `packages/queue/src/workers/schema-worker.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import { applySchemaActions } from '@spatula/core';
import type { JobConfig } from '@spatula/core';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('schema-worker');

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
): Promise<void> {
  const { jobId, tenantId } = data;

  try {
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping evolution');
      return;
    }

    const config = job.config as JobConfig;

    // Skip if evolution is not configured
    if (!config.schema.evolutionConfig?.enabled) {
      logger.debug({ jobId }, 'schema evolution disabled for this job');
      return;
    }

    const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!currentSchema) {
      logger.warn({ jobId }, 'no schema found, skipping evolution');
      return;
    }

    // Fetch recent extractions for analysis
    const batchSize = config.schema.evolutionConfig.batchSize ?? 10;
    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      limit: batchSize,
    });

    if (extractions.length === 0) {
      logger.debug({ jobId }, 'no extractions to analyze');
      return;
    }

    // Map DB rows to ExtractionResult shape expected by evolve()
    const extractionResults = extractions.map((e) => ({
      id: e.id,
      jobId: e.jobId,
      pageId: e.pageId,
      schemaVersion: e.schemaVersion,
      data: e.data as Record<string, unknown>,
      metadata: e.metadata as {
        confidence: number;
        modelUsed: string;
        tokensUsed: number;
        extractionTimeMs: number;
        unmappedFields: Array<{ name: string; value: unknown; suggestedType: string }>;
      },
    }));

    logger.info(
      { jobId, schemaVersion: currentSchema.version, extractionCount: extractionResults.length },
      'starting schema evolution',
    );

    const actions = await deps.schemaEvolver.evolve(
      currentSchema.definition,
      extractionResults,
      config.description,
    );

    if (actions.length === 0) {
      logger.info({ jobId }, 'no schema evolution actions proposed');
      return;
    }

    // Apply actions to create new schema version
    const evolvedSchema = applySchemaActions(currentSchema.definition, actions);

    if (evolvedSchema.version === currentSchema.definition.version) {
      logger.info({ jobId }, 'no actionable changes after applying actions');
      return;
    }

    await deps.schemaRepo.create({
      jobId,
      tenantId,
      version: evolvedSchema.version,
      definition: evolvedSchema,
      parentId: currentSchema.id,
    });

    logger.info(
      {
        jobId,
        previousVersion: currentSchema.version,
        newVersion: evolvedSchema.version,
        actionsApplied: actions.length,
        fieldCount: evolvedSchema.fields.length,
      },
      'schema evolved',
    );
  } catch (error) {
    logger.error({ jobId, error }, 'schema evolution job failed');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/queue && npx vitest run tests/unit/workers/schema-worker.test.ts`
Expected: PASS (6 tests)

**Step 5: Fix other tests affected by WorkerDeps change**

The `worker-deps.test.ts` and `crawl-worker.test.ts` tests will need `schemaEvolver` added to their mock `WorkerDeps`. Add `schemaEvolver: { evolve: vi.fn() } as any` to every `createMockDeps()` in:

- `packages/queue/tests/unit/worker-deps.test.ts`
- `packages/queue/tests/unit/workers/crawl-worker.test.ts`

**Step 6: Run all queue tests**

Run: `cd packages/queue && npx vitest run`
Expected: All pass

**Step 7: Commit**

```bash
git add packages/queue/src/workers/schema-worker.ts packages/queue/src/worker-deps.ts packages/queue/tests/unit/workers/schema-worker.test.ts packages/queue/tests/unit/workers/crawl-worker.test.ts packages/queue/tests/unit/worker-deps.test.ts
git commit -m "feat(queue): implement schema evolution worker with full pipeline"
```

---

## Task 8: Crawl Worker — Trigger Schema Evolution

**Files:**

- Modify: `packages/queue/src/workers/crawl-worker.ts`
- Modify: `packages/queue/tests/unit/workers/crawl-worker.test.ts`

After storing an extraction, check if the batch threshold is met and enqueue a schema evolution job. This uses a simple counter approach: after each extraction, query the count of extractions for this job's current schema version. If it's a multiple of `batchSize`, trigger evolution.

**Step 1: Write the failing test**

Add to the existing `crawl-worker.test.ts`:

```typescript
it('enqueues schema evolution job after batch threshold', async () => {
  // Make extractionRepo.findByJob return enough extractions to trigger evolution
  // (10 = default batch size)
  const fakeExtractions = Array.from({ length: 10 }, (_, i) => ({ id: `ext-${i}` }));
  (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue(fakeExtractions);

  // Ensure the job has evolution enabled
  (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'job-1',
    tenantId: 'tenant-1',
    status: 'running',
    config: {
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 3, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: {
        mode: 'discovery',
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
          tableStrategy: 'auto',
        },
      },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    },
  });

  const data = createJobData();
  await processCrawlJob(data, deps);

  expect(deps.queues.schemaEvolution.add).toHaveBeenCalledWith(
    expect.stringContaining('schema-evolution:'),
    expect.objectContaining({
      jobId: 'job-1',
      tenantId: 'tenant-1',
      extractionIds: expect.any(Array),
    }),
  );
});

it('does NOT trigger schema evolution when batch threshold not met', async () => {
  // Return fewer than batch size
  (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'ext-1' },
    { id: 'ext-2' },
  ]);

  const data = createJobData();
  await processCrawlJob(data, deps);

  expect(deps.queues.schemaEvolution.add).not.toHaveBeenCalled();
});

it('does NOT trigger schema evolution for fixed schema mode', async () => {
  (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'job-1',
    tenantId: 'tenant-1',
    status: 'running',
    config: {
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Scrape product data',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 3, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'fixed' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    },
  });

  const data = createJobData();
  await processCrawlJob(data, deps);

  expect(deps.queues.schemaEvolution.add).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/workers/crawl-worker.test.ts`
Expected: FAIL — new tests fail (schemaEvolution.add not called)

**Step 3: Modify crawl-worker.ts**

Add after the extraction block (after `deps.extractionRepo.store()`), before the link enqueuing:

```typescript
// Check if we should trigger schema evolution
if (config.schema.evolutionConfig?.enabled) {
  const batchSize = config.schema.evolutionConfig.batchSize ?? 10;
  const recentExtractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
    limit: batchSize,
  });

  if (recentExtractions.length >= batchSize && recentExtractions.length % batchSize === 0) {
    const extractionIds = recentExtractions.map((e) => e.id);
    await deps.queues.schemaEvolution.add(`schema-evolution:${jobId}:v${Date.now()}`, {
      jobId,
      tenantId,
      extractionIds,
    });
    logger.debug(
      { jobId, extractionCount: recentExtractions.length },
      'schema evolution triggered',
    );
  }
}
```

Also need to add `extractionRepo.findByJob` to the mock in `createMockDeps()` if not already present.

**Step 4: Run test to verify it passes**

Run: `cd packages/queue && npx vitest run tests/unit/workers/crawl-worker.test.ts`
Expected: All pass (11 tests)

**Step 5: Commit**

```bash
git add packages/queue/src/workers/crawl-worker.ts packages/queue/tests/unit/workers/crawl-worker.test.ts
git commit -m "feat(queue): trigger schema evolution from crawl worker after batch threshold"
```

---

## Task 9: Barrel Exports and Full Build Verification

**Files:**

- Verify: `packages/core/src/index.ts` (evolution exports)
- Verify: `packages/queue/src/index.ts` (schema worker exports)
- Test: `packages/core/tests/unit/evolution/exports.test.ts`

**Step 1: Write export verification test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  aggregateUnmappedFields,
  applySchemaActions,
  FieldProposer,
  SynonymDetector,
  NormalizationProposer,
  SchemaEvolverImpl,
} from '../../../src/evolution/index.js';

describe('evolution module exports', () => {
  it('exports aggregateUnmappedFields', () => {
    expect(typeof aggregateUnmappedFields).toBe('function');
  });

  it('exports applySchemaActions', () => {
    expect(typeof applySchemaActions).toBe('function');
  });

  it('exports FieldProposer', () => {
    expect(FieldProposer).toBeDefined();
  });

  it('exports SynonymDetector', () => {
    expect(SynonymDetector).toBeDefined();
  });

  it('exports NormalizationProposer', () => {
    expect(NormalizationProposer).toBeDefined();
  });

  it('exports SchemaEvolverImpl', () => {
    expect(SchemaEvolverImpl).toBeDefined();
  });
});
```

**Step 2: Run test**

Run: `cd packages/core && npx vitest run tests/unit/evolution/exports.test.ts`
Expected: PASS

**Step 3: Run full build and test suite**

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm test
```

Expected: All pass. The test count should increase by ~25+ new tests.

**Step 4: Commit**

```bash
git add packages/core/tests/unit/evolution/exports.test.ts
git commit -m "test(core): add evolution module export verification"
```

---

## Summary

| Task      | Component                      | New Tests | Key Files                                      |
| --------- | ------------------------------ | --------- | ---------------------------------------------- |
| 1         | Unmapped field aggregator      | 4         | `core/src/evolution/unmapped-aggregator.ts`    |
| 2         | Schema action applier          | 8         | `core/src/evolution/schema-action-applier.ts`  |
| 3         | LLM field proposer             | 3         | `core/src/evolution/field-proposer.ts`         |
| 4         | LLM synonym detector           | 3         | `core/src/evolution/synonym-detector.ts`       |
| 5         | LLM normalization proposer     | 3         | `core/src/evolution/normalization-proposer.ts` |
| 6         | SchemaEvolverImpl orchestrator | 3         | `core/src/evolution/schema-evolver-impl.ts`    |
| 7         | Schema evolution worker        | 6         | `queue/src/workers/schema-worker.ts`           |
| 8         | Crawl worker evolution trigger | 3         | `queue/src/workers/crawl-worker.ts`            |
| 9         | Exports + full verification    | 6         | barrel index files                             |
| **Total** |                                | **~39**   |                                                |
