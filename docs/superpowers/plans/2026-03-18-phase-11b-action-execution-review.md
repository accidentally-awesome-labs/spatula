# Phase 11b: Action Execution & Review — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ActionExecutor and ReviewQueue so safety policies route actions — safe ones auto-apply, risky ones queue for user review.

**Architecture:** Policy-driven execution layer between action producers (workers) and action consumers (schema/entity state). A static safety policy map categorizes each action type; user-configurable presets (trust_ai/balanced/cautious/manual) adjust thresholds. Domain-specific appliers handle schema, category, reconciliation, and finalization actions independently. The ReviewQueue is backed by ActionRepository (not BullMQ) and bridges the executor with the CLI Review Mode and API action endpoints.

**Tech Stack:** TypeScript, Zod, Vitest, @spatula/core, @spatula/db (ActionRepository, SchemaRepository, EntityRepository)

---

## Prerequisites

- Phase 11a complete (ActionRepository.create(), distributed lock, E2E test passing)
- Design spec: `docs/superpowers/specs/2026-03-17-phase-11-production-hardening-design.md` (section 11b)

## File Map

```
Created:
  packages/core/src/execution/safety-policy.ts              — Safety policy map + approval preset logic
  packages/core/src/execution/category-applier.ts           — Applies define_category + assign_category_fields
  packages/core/src/execution/reconciliation-applier.ts     — Applies resolve_conflict, infer_value, correct_value, match_entities, split_entities, set_source_trust
  packages/core/src/execution/finalization-applier.ts       — Applies recommend_table_structure, derive_field, flag_anomaly, generate_documentation
  packages/core/src/execution/review-queue.ts               — DefaultReviewQueue implementation
  packages/core/src/execution/action-executor-impl.ts       — DefaultActionExecutor implementation
  packages/core/src/execution/index.ts                      — Barrel exports

  packages/core/tests/unit/execution/safety-policy.test.ts
  packages/core/tests/unit/execution/category-applier.test.ts
  packages/core/tests/unit/execution/reconciliation-applier.test.ts
  packages/core/tests/unit/execution/finalization-applier.test.ts
  packages/core/tests/unit/execution/review-queue.test.ts
  packages/core/tests/unit/execution/action-executor-impl.test.ts

Modified:
  packages/core/src/evolution/schema-action-applier.ts      — Add split_field + group_fields cases
  packages/core/src/evolution/index.ts                      — (no change needed, already exports applySchemaActions)
  packages/core/src/index.ts                                — Add execution barrel export
  packages/core/tests/unit/evolution/schema-action-applier.test.ts — Add split_field + group_fields tests

  packages/db/src/repositories/entity-repository.ts         — Add updateMergedData() for reconciliation applier
  packages/db/src/repositories/index.ts                     — Export UpdateEntityInput type
  packages/db/tests/unit/repositories/entity-repository.test.ts — Add updateMergedData() tests

  apps/api/src/routes/actions.ts                            — Route approve/reject through ReviewQueue
  apps/api/src/types.ts                                     — Add optional reviewQueue to AppDeps
  apps/api/tests/unit/routes/actions.test.ts                — Update tests for ReviewQueue integration
```

---

## Task 1: Safety Policy Map & Approval Presets

**Files:**
- Create: `packages/core/src/execution/safety-policy.ts`
- Create: `packages/core/tests/unit/execution/safety-policy.test.ts`

This is the foundation — a pure-data module that maps each action type to its default safety policy and resolves the effective policy based on a user-chosen approval preset.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/safety-policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SAFETY_POLICY_MAP,
  resolvePolicy,
  shouldAutoApply,
  type ApprovalPreset,
} from '../../../src/execution/safety-policy.js';

describe('SAFETY_POLICY_MAP', () => {
  it('maps classify_page to always_auto', () => {
    expect(SAFETY_POLICY_MAP.classify_page).toBe('always_auto');
  });

  it('maps add_field to auto_above_threshold', () => {
    expect(SAFETY_POLICY_MAP.add_field).toBe('auto_above_threshold');
  });

  it('maps merge_fields to batch_review', () => {
    expect(SAFETY_POLICY_MAP.merge_fields).toBe('batch_review');
  });

  it('maps remove_field to always_review', () => {
    expect(SAFETY_POLICY_MAP.remove_field).toBe('always_review');
  });

  it('covers all 25 pipeline action types', () => {
    expect(Object.keys(SAFETY_POLICY_MAP)).toHaveLength(25);
  });
});

describe('resolvePolicy', () => {
  it('returns always_auto unchanged for balanced preset', () => {
    expect(resolvePolicy('classify_page', 'balanced')).toBe('always_auto');
  });

  it('returns always_auto for everything under trust_ai', () => {
    expect(resolvePolicy('remove_field', 'trust_ai')).toBe('always_auto');
    expect(resolvePolicy('merge_fields', 'trust_ai')).toBe('always_auto');
  });

  it('promotes auto_above_threshold to batch_review under cautious', () => {
    expect(resolvePolicy('add_field', 'cautious')).toBe('batch_review');
  });

  it('returns always_review for everything under manual', () => {
    expect(resolvePolicy('classify_page', 'manual')).toBe('always_review');
    expect(resolvePolicy('add_field', 'manual')).toBe('always_review');
  });

  it('returns always_review as fallback for unknown action type', () => {
    expect(resolvePolicy('unknown_type' as any, 'balanced')).toBe('always_review');
  });
});

describe('shouldAutoApply', () => {
  it('returns true for always_auto regardless of confidence', () => {
    expect(shouldAutoApply('always_auto', 0.1, 0.7)).toBe(true);
  });

  it('returns true for auto_above_threshold when confidence >= threshold', () => {
    expect(shouldAutoApply('auto_above_threshold', 0.8, 0.7)).toBe(true);
    expect(shouldAutoApply('auto_above_threshold', 0.7, 0.7)).toBe(true);
  });

  it('returns false for auto_above_threshold when confidence < threshold', () => {
    expect(shouldAutoApply('auto_above_threshold', 0.6, 0.7)).toBe(false);
  });

  it('returns false for batch_review', () => {
    expect(shouldAutoApply('batch_review', 1.0, 0.7)).toBe(false);
  });

  it('returns false for always_review', () => {
    expect(shouldAutoApply('always_review', 1.0, 0.7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/safety-policy.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement safety-policy.ts**

Create `packages/core/src/execution/safety-policy.ts`:

```typescript
import type { SafetyPolicy } from '../types/actions.js';

export type ApprovalPreset = 'trust_ai' | 'balanced' | 'cautious' | 'manual';

/**
 * Static mapping from pipeline action type to its default safety policy.
 * This determines whether an action auto-applies or requires human review.
 */
export const SAFETY_POLICY_MAP: Record<string, SafetyPolicy> = {
  // always_auto — low risk, produced inline by workers
  classify_page: 'always_auto',
  enqueue_links: 'always_auto',
  hint_entity_match: 'always_auto',
  update_enum_map: 'always_auto',
  flag_anomaly: 'always_auto',
  generate_documentation: 'always_auto',

  // auto_above_threshold — safe at high confidence
  add_field: 'auto_above_threshold',
  modify_field: 'auto_above_threshold',
  set_normalization_rule: 'auto_above_threshold',
  define_category: 'auto_above_threshold',
  assign_category_fields: 'auto_above_threshold',
  match_entities: 'auto_above_threshold',
  set_source_trust: 'auto_above_threshold',
  reprocess_extraction: 'auto_above_threshold',

  // batch_review — structural changes that benefit from human review
  merge_fields: 'batch_review',
  rename_field: 'batch_review',
  split_field: 'batch_review',
  group_fields: 'batch_review',
  resolve_conflict: 'batch_review',
  infer_value: 'batch_review',
  correct_value: 'batch_review',
  split_entities: 'batch_review',

  // always_review — destructive or high-impact
  remove_field: 'always_review',
  recommend_table_structure: 'always_review',
  derive_field: 'always_review',
};

/**
 * Resolve the effective policy for an action type given a user's approval preset.
 */
export function resolvePolicy(actionType: string, preset: ApprovalPreset): SafetyPolicy {
  if (preset === 'trust_ai') return 'always_auto';
  if (preset === 'manual') return 'always_review';

  const basePolicy = SAFETY_POLICY_MAP[actionType];
  if (!basePolicy) return 'always_review';

  if (preset === 'cautious' && basePolicy === 'auto_above_threshold') {
    return 'batch_review';
  }

  return basePolicy;
}

/**
 * Determine whether an action should auto-apply based on its resolved policy and confidence.
 */
export function shouldAutoApply(
  policy: SafetyPolicy,
  confidence: number,
  threshold: number,
): boolean {
  switch (policy) {
    case 'always_auto':
      return true;
    case 'auto_above_threshold':
      return confidence >= threshold;
    case 'batch_review':
    case 'always_review':
      return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/safety-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/safety-policy.ts packages/core/tests/unit/execution/safety-policy.test.ts
git commit -m "feat(core): add safety policy map and approval preset resolution"
```

---

## Task 2: Extend Schema Action Applier — split_field + group_fields

**Files:**
- Modify: `packages/core/src/evolution/schema-action-applier.ts`
- Modify: `packages/core/tests/unit/evolution/schema-action-applier.test.ts`

The existing applier handles 7 of 9 schema/normalization action types. The spec notes that `split_field` and `group_fields` fall through to the default case and are silently skipped. We need to add them.

- [ ] **Step 1: Write failing tests for split_field**

Add to `packages/core/tests/unit/evolution/schema-action-applier.test.ts` inside the existing describe block, before the "unsupported action types" section:

```typescript
// --- split_field ---

it('split_field: removes source and inserts target fields at same position', () => {
  const schema = makeSchema([
    makeField('name'),
    makeField('full_address', { description: 'Full street address' }),
    makeField('price'),
  ]);

  const action: PipelineAction = {
    ...baseAction(),
    type: 'split_field',
    payload: {
      sourceField: 'full_address',
      targetFields: [
        makeField('street', { description: 'Street name and number' }),
        makeField('city', { description: 'City name' }),
        makeField('zip', { description: 'ZIP/postal code' }),
      ],
      splitLogic: 'Parse address components',
      examples: [
        {
          sourceValue: '123 Main St, Springfield, 62701',
          targetValues: { street: '123 Main St', city: 'Springfield', zip: '62701' },
        },
      ],
    },
  };

  const result = applySchemaActions(schema, [action]);

  expect(result.version).toBe(2);
  expect(result.fields).toHaveLength(5); // name + street + city + zip + price
  expect(result.fields.map((f) => f.name)).toEqual(['name', 'street', 'city', 'zip', 'price']);
});

it('split_field: skips when source field not found', () => {
  const schema = makeSchema([makeField('title')]);

  const action: PipelineAction = {
    ...baseAction(),
    type: 'split_field',
    payload: {
      sourceField: 'nonexistent',
      targetFields: [makeField('a'), makeField('b')],
      splitLogic: 'test',
      examples: [],
    },
  };

  const result = applySchemaActions(schema, [action]);
  expect(result.version).toBe(1);
});
```

- [ ] **Step 2: Write failing tests for group_fields**

Add after the split_field tests:

```typescript
// --- group_fields ---

it('group_fields: removes source fields and creates new object field', () => {
  const schema = makeSchema([
    makeField('name'),
    makeField('street'),
    makeField('city'),
    makeField('zip'),
    makeField('price'),
  ]);

  const action: PipelineAction = {
    ...baseAction(),
    type: 'group_fields',
    payload: {
      targetFieldName: 'address',
      targetFieldType: 'object',
      sourceFields: ['street', 'city', 'zip'],
      mapping: { street: 'street', city: 'city', zip: 'zipCode' },
    },
  };

  const result = applySchemaActions(schema, [action]);

  expect(result.version).toBe(2);
  expect(result.fields).toHaveLength(3); // name + address + price
  expect(result.fields.map((f) => f.name)).toEqual(['name', 'address', 'price']);

  const addressField = result.fields.find((f) => f.name === 'address')!;
  expect(addressField.type).toBe('object');
  expect(addressField.objectFields).toHaveLength(3);
  expect(addressField.objectFields!.map((f) => f.name)).toEqual(['street', 'city', 'zipCode']);
});

it('group_fields: handles partial matches (only some source fields exist)', () => {
  const schema = makeSchema([
    makeField('name'),
    makeField('street'),
    makeField('price'),
  ]);

  const action: PipelineAction = {
    ...baseAction(),
    type: 'group_fields',
    payload: {
      targetFieldName: 'address',
      targetFieldType: 'object',
      sourceFields: ['street', 'city', 'zip'], // city and zip don't exist
      mapping: { street: 'street', city: 'city', zip: 'zipCode' },
    },
  };

  const result = applySchemaActions(schema, [action]);

  expect(result.version).toBe(2);
  expect(result.fields).toHaveLength(3); // name + address + price
  const addressField = result.fields.find((f) => f.name === 'address')!;
  expect(addressField.objectFields).toHaveLength(1); // only 'street' matched
  expect(addressField.objectFields![0].name).toBe('street');
});

it('group_fields: skips when no source fields exist', () => {
  const schema = makeSchema([makeField('title')]);

  const action: PipelineAction = {
    ...baseAction(),
    type: 'group_fields',
    payload: {
      targetFieldName: 'address',
      targetFieldType: 'object',
      sourceFields: ['nonexistent_a', 'nonexistent_b'],
      mapping: { nonexistent_a: 'a', nonexistent_b: 'b' },
    },
  };

  const result = applySchemaActions(schema, [action]);
  expect(result.version).toBe(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/evolution/schema-action-applier.test.ts`
Expected: FAIL — split_field and group_fields tests fail (actions are silently skipped, version stays at 1)

- [ ] **Step 4: Implement split_field case**

In `packages/core/src/evolution/schema-action-applier.ts`, add the `split_field` case after the `merge_fields` case (before `set_normalization_rule`):

```typescript
case 'split_field': {
  const idx = fields.findIndex((f) => f.name === action.payload.sourceField);
  if (idx === -1) {
    logger.debug(
      { sourceField: action.payload.sourceField },
      'Skipping split_field: source field not found',
    );
    break;
  }
  // Remove source field and insert targets at the same position
  fields.splice(idx, 1, ...structuredClone(action.payload.targetFields));
  applied++;
  break;
}
```

- [ ] **Step 5: Implement group_fields case**

Add the `group_fields` case after `split_field`:

```typescript
case 'group_fields': {
  const { targetFieldName, sourceFields: sourceFieldNames, mapping } = action.payload;

  // Find positions of source fields
  const sourceIndices = sourceFieldNames
    .map((name) => fields.findIndex((f) => f.name === name))
    .filter((idx) => idx !== -1);

  if (sourceIndices.length === 0) {
    logger.debug(
      { sourceFields: sourceFieldNames },
      'Skipping group_fields: no source fields found',
    );
    break;
  }

  // Build object sub-fields from source field definitions using the mapping
  const objectFields: FieldDefinition[] = sourceIndices.map((idx) => {
    const sourceField = fields[idx];
    const mappedName = mapping[sourceField.name] ?? sourceField.name;
    return structuredClone({ ...sourceField, name: mappedName });
  });

  // Insert position: where the first source field was
  const insertAt = Math.min(...sourceIndices);

  // Remove source fields (iterate in reverse to preserve indices)
  for (const idx of [...sourceIndices].sort((a, b) => b - a)) {
    fields.splice(idx, 1);
  }

  // Create the new object field
  const groupField: FieldDefinition = {
    name: targetFieldName,
    description: `Grouped from: ${sourceFieldNames.join(', ')}`,
    type: 'object',
    required: false,
    objectFields,
  };

  // Insert at the position of the first removed field (adjusted for removals before it)
  const adjustedInsertAt = Math.min(insertAt, fields.length);
  fields.splice(adjustedInsertAt, 0, groupField);
  applied++;
  break;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/evolution/schema-action-applier.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/evolution/schema-action-applier.ts packages/core/tests/unit/evolution/schema-action-applier.test.ts
git commit -m "feat(core): add split_field and group_fields to schema action applier"
```

---

## Task 3: Category Applier

**Files:**
- Create: `packages/core/src/execution/category-applier.ts`
- Create: `packages/core/tests/unit/execution/category-applier.test.ts`

Applies `define_category` and `assign_category_fields` actions to a schema. These store category metadata on the schema that the category-aware field relevance system uses.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/category-applier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyCategoryActions } from '../../../src/execution/category-applier.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.9,
  };
}

function makeSchema(overrides: Partial<SchemaDefinition> = {}): SchemaDefinition {
  return {
    version: 1,
    fields: [
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
    ...overrides,
  };
}

describe('applyCategoryActions', () => {
  describe('define_category', () => {
    it('adds categories to schema metadata', () => {
      const schema = makeSchema();
      const action: PipelineAction = {
        ...baseAction(),
        type: 'define_category',
        payload: {
          categoryField: 'product_type',
          categories: [
            { name: 'electronics', description: 'Electronic devices', matchCriteria: 'tech products' },
            { name: 'clothing', description: 'Apparel', matchCriteria: 'wearable items' },
          ],
        },
      };

      const result = applyCategoryActions(schema, [action]);

      expect(result.categories).toBeDefined();
      expect(result.categories!.categoryField).toBe('product_type');
      expect(result.categories!.definitions).toHaveLength(2);
      expect(result.categories!.definitions[0].name).toBe('electronics');
    });

    it('overwrites previous category definitions', () => {
      const schema = makeSchema();
      const actions: PipelineAction[] = [
        {
          ...baseAction(),
          type: 'define_category',
          payload: {
            categoryField: 'type_a',
            categories: [{ name: 'old', description: 'Old', matchCriteria: 'old' }],
          },
        },
        {
          ...baseAction(),
          type: 'define_category',
          payload: {
            categoryField: 'type_b',
            categories: [{ name: 'new', description: 'New', matchCriteria: 'new' }],
          },
        },
      ];

      const result = applyCategoryActions(schema, actions);
      expect(result.categories!.categoryField).toBe('type_b');
    });
  });

  describe('assign_category_fields', () => {
    it('records field assignments per category', () => {
      const schema = makeSchema();
      const action: PipelineAction = {
        ...baseAction(),
        type: 'assign_category_fields',
        payload: {
          category: 'electronics',
          requiredFields: ['title', 'price'],
          optionalFields: ['warranty'],
        },
      };

      const result = applyCategoryActions(schema, [action]);

      expect(result.categoryFieldAssignments).toBeDefined();
      expect(result.categoryFieldAssignments!['electronics']).toEqual({
        requiredFields: ['title', 'price'],
        optionalFields: ['warranty'],
      });
    });

    it('accumulates assignments for multiple categories', () => {
      const schema = makeSchema();
      const actions: PipelineAction[] = [
        {
          ...baseAction(),
          type: 'assign_category_fields',
          payload: {
            category: 'electronics',
            requiredFields: ['title'],
            optionalFields: [],
          },
        },
        {
          ...baseAction(),
          type: 'assign_category_fields',
          payload: {
            category: 'clothing',
            requiredFields: ['size'],
            optionalFields: ['color'],
          },
        },
      ];

      const result = applyCategoryActions(schema, actions);
      expect(Object.keys(result.categoryFieldAssignments!)).toHaveLength(2);
    });
  });

  it('skips non-category action types', () => {
    const schema = makeSchema();
    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: { name: 'x', description: 'x', type: 'string', required: false },
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = applyCategoryActions(schema, [action]);
    expect(result.categories).toBeUndefined();
    expect(result.categoryFieldAssignments).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/category-applier.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement category-applier.ts**

Create `packages/core/src/execution/category-applier.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';
import type { SchemaDefinition } from '../types/schema.js';

const logger = createLogger('category-applier');

export interface CategoryDefinition {
  name: string;
  description: string;
  matchCriteria: string;
}

export interface CategoryMetadata {
  categoryField: string;
  definitions: CategoryDefinition[];
}

export interface CategoryFieldAssignment {
  requiredFields: string[];
  optionalFields: string[];
}

/**
 * Result of applying category actions. Stored separately from SchemaDefinition
 * (the SchemaDefinition Zod schema would strip unknown properties). This metadata
 * is persisted in the action audit log's stateChanges, not in the schema itself.
 */
export interface CategoryApplierResult {
  categories?: CategoryMetadata;
  categoryFieldAssignments?: Record<string, CategoryFieldAssignment>;
}

/**
 * Apply category-related actions, returning category metadata.
 * Only processes define_category and assign_category_fields; others are skipped.
 * The metadata is stored in the action record, not the SchemaDefinition.
 */
export function applyCategoryActions(
  schema: SchemaDefinition,
  actions: PipelineAction[],
): CategoryApplierResult {
  let categories: CategoryMetadata | undefined;
  let assignments: Record<string, CategoryFieldAssignment> | undefined;

  for (const action of actions) {
    switch (action.type) {
      case 'define_category': {
        categories = {
          categoryField: action.payload.categoryField,
          definitions: action.payload.categories.map((c) => ({
            name: c.name,
            description: c.description,
            matchCriteria: c.matchCriteria,
          })),
        };
        logger.debug(
          { categoryField: action.payload.categoryField, count: action.payload.categories.length },
          'categories defined',
        );
        break;
      }

      case 'assign_category_fields': {
        if (!assignments) assignments = {};
        assignments[action.payload.category] = {
          requiredFields: [...action.payload.requiredFields],
          optionalFields: [...action.payload.optionalFields],
        };
        logger.debug(
          { category: action.payload.category },
          'category fields assigned',
        );
        break;
      }

      default:
        // Not a category action — skip
        break;
    }
  }

  return {
    ...(categories ? { categories } : {}),
    ...(assignments ? { categoryFieldAssignments: assignments } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/category-applier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/category-applier.ts packages/core/tests/unit/execution/category-applier.test.ts
git commit -m "feat(core): add category applier for define_category and assign_category_fields"
```

---

## Task 4: Entity Repository — updateMergedData

**Files:**
- Modify: `packages/db/src/repositories/entity-repository.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Modify: `packages/db/tests/unit/repositories/entity-repository.test.ts`

The reconciliation applier needs to update entity fields. The current EntityRepository has `create`, `findById`, `findByJob`, and `updateQualityScore` but no method to update `mergedData` or `provenance`. We need `updateMergedData()`.

- [ ] **Step 1: Write failing tests**

Add to `packages/db/tests/unit/repositories/entity-repository.test.ts` inside the existing describe block:

```typescript
it('updateMergedData updates data and provenance', async () => {
  const updateChainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{
      id: 'entity-1',
      mergedData: { name: 'Updated' },
      provenance: { name: { provenanceType: 'merged' } },
    }]),
  };
  mockDb.update = vi.fn().mockReturnValue(updateChainable);

  const result = await repo.updateMergedData('entity-1', 'tenant-1', {
    mergedData: { name: 'Updated' },
    provenance: { name: { provenanceType: 'merged' } },
  });

  expect(mockDb.update).toHaveBeenCalled();
  expect(result.mergedData).toEqual({ name: 'Updated' });
});

it('updateMergedData throws StorageError when entity not found', async () => {
  const updateChainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  mockDb.update = vi.fn().mockReturnValue(updateChainable);

  await expect(
    repo.updateMergedData('nonexistent', 'tenant-1', {
      mergedData: { name: 'x' },
    }),
  ).rejects.toThrow('not found');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`
Expected: FAIL — `repo.updateMergedData is not a function`

- [ ] **Step 3: Implement updateMergedData**

Add to `packages/db/src/repositories/entity-repository.ts`, after `updateQualityScore`:

```typescript
async updateMergedData(
  entityId: string,
  tenantId: string,
  changes: {
    mergedData?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
    categories?: string[];
  },
) {
  try {
    const setClause: Record<string, unknown> = {};
    if (changes.mergedData !== undefined) setClause.mergedData = changes.mergedData;
    if (changes.provenance !== undefined) setClause.provenance = changes.provenance;
    if (changes.categories !== undefined) setClause.categories = changes.categories;

    const [row] = await this.db
      .update(entities)
      .set(setClause)
      .where(and(eq(entities.id, entityId), eq(entities.tenantId, tenantId)))
      .returning();

    if (!row) {
      throw new StorageError(`Entity ${entityId} not found`, {
        context: { entityId, tenantId },
      });
    }

    logger.debug({ entityId }, 'entity merged data updated');
    return row;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(`Failed to update entity data: ${(error as Error).message}`, {
      cause: error as Error,
      context: { entityId, tenantId },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/entity-repository.ts packages/db/tests/unit/repositories/entity-repository.test.ts
git commit -m "feat(db): add EntityRepository.updateMergedData() for reconciliation actions"
```

---

## Task 5: Reconciliation Applier

**Files:**
- Create: `packages/core/src/execution/reconciliation-applier.ts`
- Create: `packages/core/tests/unit/execution/reconciliation-applier.test.ts`

Applies reconciliation actions: `resolve_conflict`, `infer_value`, `correct_value`, `match_entities`, `split_entities`, `set_source_trust`. These operate on entity data via repository calls.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/reconciliation-applier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyReconciliationAction,
  type ReconciliationDeps,
} from '../../../src/execution/reconciliation-applier.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'reconciliation',
    reasoning: 'test',
    confidence: 0.9,
  };
}

function createMockDeps(): ReconciliationDeps {
  return {
    entityRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'entity-1',
        tenantId: 'tenant-1',
        mergedData: { name: 'Widget', price: 10 },
        provenance: {
          name: { finalValue: 'Widget', provenanceType: 'extracted', sources: [], hadConflict: false },
        },
      }),
      updateMergedData: vi.fn().mockImplementation((_id, _tid, changes) =>
        Promise.resolve({ id: 'entity-1', ...changes }),
      ),
    } as any,
    entitySourceRepo: {
      link: vi.fn().mockResolvedValue({ entityId: 'entity-1', extractionId: 'ext-1' }),
      bulkLink: vi.fn().mockResolvedValue([]),
      findByEntity: vi.fn().mockResolvedValue([]),
    } as any,
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'st-1' }),
    } as any,
  };
}

describe('applyReconciliationAction', () => {
  let deps: ReconciliationDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolve_conflict updates entity field value and provenance', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'resolve_conflict',
      payload: {
        entityId: 'entity-1',
        fieldName: 'name',
        resolvedValue: 'Super Widget',
        sourcePreferred: 'source-a.com',
        allValues: [
          { source: 'source-a.com', value: 'Super Widget' },
          { source: 'source-b.com', value: 'Widget' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.findById).toHaveBeenCalledWith('entity-1', 'tenant-1');
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ name: 'Super Widget' }),
      }),
    );
  });

  it('infer_value adds a new field with inferred provenance', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'infer_value',
      payload: {
        entityId: 'entity-1',
        fieldName: 'category',
        inferredValue: 'electronics',
        inferredFrom: 'product name and price patterns',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ category: 'electronics' }),
      }),
    );
  });

  it('correct_value overwrites field with correction', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'correct_value',
      payload: {
        entityId: 'entity-1',
        fieldName: 'price',
        currentValue: 10,
        correctedValue: 9.99,
        correctionType: 'format_fix',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ price: 9.99 }),
      }),
    );
  });

  it('match_entities links additional extractions to an entity', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'match_entities',
      payload: {
        entityId: 'entity-1',
        extractionIds: ['ext-1', 'ext-2'],
        matchedOn: ['name', 'brand'],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entitySourceRepo.bulkLink).toHaveBeenCalledWith([
      { entityId: 'entity-1', extractionId: 'ext-1', matchConfidence: 0.9 },
      { entityId: 'entity-1', extractionId: 'ext-2', matchConfidence: 0.9 },
    ]);
  });

  it('set_source_trust upserts trust rankings', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'set_source_trust',
      payload: {
        rankings: [
          { domain: 'trusted.com', trustLevel: 'high', reasoning: 'Reliable source' },
          { domain: 'sketchy.com', trustLevel: 'low', reasoning: 'Often inaccurate' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.sourceTrustRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it('returns applied=false for entity not found', async () => {
    (deps.entityRepo.findById as any).mockResolvedValue(null);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'resolve_conflict',
      payload: {
        entityId: 'missing',
        fieldName: 'name',
        resolvedValue: 'x',
        sourcePreferred: 'a.com',
        allValues: [{ source: 'a.com', value: 'x' }],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('split_entities returns applied=false (not implemented in v1)', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'split_entities',
      payload: {
        entityId: 'entity-1',
        newGroups: [
          { extractionIds: ['ext-1'], reasoning: 'group A' },
          { extractionIds: ['ext-2'], reasoning: 'group B' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not yet implemented');
  });

  it('returns applied=false for unsupported action type', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: { name: 'x', description: 'x', type: 'string', required: false },
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/reconciliation-applier.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement reconciliation-applier.ts**

Create `packages/core/src/execution/reconciliation-applier.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';

const logger = createLogger('reconciliation-applier');

/**
 * Minimal dependency interface — avoids importing concrete repository classes.
 * The action executor provides the real implementations.
 */
export interface ReconciliationDeps {
  entityRepo: {
    findById(entityId: string, tenantId: string): Promise<{
      id: string;
      mergedData: Record<string, unknown>;
      provenance: Record<string, unknown>;
    } | null>;
    updateMergedData(
      entityId: string,
      tenantId: string,
      changes: {
        mergedData?: Record<string, unknown>;
        provenance?: Record<string, unknown>;
      },
    ): Promise<unknown>;
  };
  entitySourceRepo: {
    bulkLink(
      links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
    ): Promise<unknown>;
  };
  sourceTrustRepo: {
    upsert(input: {
      jobId: string;
      tenantId: string;
      domain: string;
      trustLevel: string;
      reasoning: string;
    }): Promise<unknown>;
  };
}

export interface ReconciliationResult {
  applied: boolean;
  reason?: string;
  stateChanges?: Array<{ path: string; before: unknown; after: unknown }>;
}

export async function applyReconciliationAction(
  action: PipelineAction,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  switch (action.type) {
    case 'resolve_conflict':
      return applyResolveConflict(action, tenantId, deps);
    case 'infer_value':
      return applyInferValue(action, tenantId, deps);
    case 'correct_value':
      return applyCorrectValue(action, tenantId, deps);
    case 'match_entities':
      return applyMatchEntities(action, tenantId, deps);
    case 'split_entities':
      return applySplitEntities(action, tenantId, deps);
    case 'set_source_trust':
      return applySetSourceTrust(action, tenantId, deps);
    default:
      return { applied: false, reason: `Not a reconciliation action: ${action.type}` };
  }
}

async function applyResolveConflict(
  action: Extract<PipelineAction, { type: 'resolve_conflict' }>,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const entity = await deps.entityRepo.findById(action.payload.entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${action.payload.entityId} not found` };
  }

  const before = entity.mergedData[action.payload.fieldName];
  const mergedData = { ...entity.mergedData, [action.payload.fieldName]: action.payload.resolvedValue };
  const provenance = {
    ...entity.provenance,
    [action.payload.fieldName]: {
      finalValue: action.payload.resolvedValue,
      provenanceType: 'merged',
      sources: action.payload.allValues.map((v) => ({
        sourceUrl: v.source,
        rawValue: v.value,
        normalizedValue: v.value,
      })),
      hadConflict: true,
      resolution: { strategy: 'source_preferred', preferredSource: action.payload.sourcePreferred },
    },
  };

  await deps.entityRepo.updateMergedData(action.payload.entityId, tenantId, { mergedData, provenance });

  return {
    applied: true,
    stateChanges: [{ path: `entity.${action.payload.fieldName}`, before, after: action.payload.resolvedValue }],
  };
}

async function applyInferValue(
  action: Extract<PipelineAction, { type: 'infer_value' }>,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const entity = await deps.entityRepo.findById(action.payload.entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${action.payload.entityId} not found` };
  }

  const before = entity.mergedData[action.payload.fieldName];
  const mergedData = { ...entity.mergedData, [action.payload.fieldName]: action.payload.inferredValue };
  const provenance = {
    ...entity.provenance,
    [action.payload.fieldName]: {
      finalValue: action.payload.inferredValue,
      provenanceType: 'inferred',
      sources: [],
      hadConflict: false,
    },
  };

  await deps.entityRepo.updateMergedData(action.payload.entityId, tenantId, { mergedData, provenance });

  return {
    applied: true,
    stateChanges: [{ path: `entity.${action.payload.fieldName}`, before, after: action.payload.inferredValue }],
  };
}

async function applyCorrectValue(
  action: Extract<PipelineAction, { type: 'correct_value' }>,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const entity = await deps.entityRepo.findById(action.payload.entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${action.payload.entityId} not found` };
  }

  const mergedData = { ...entity.mergedData, [action.payload.fieldName]: action.payload.correctedValue };
  const provenance = {
    ...entity.provenance,
    [action.payload.fieldName]: {
      finalValue: action.payload.correctedValue,
      provenanceType: 'normalized',
      sources: [{
        sourceUrl: 'correction',
        rawValue: action.payload.currentValue,
        normalizedValue: action.payload.correctedValue,
      }],
      hadConflict: false,
    },
  };

  await deps.entityRepo.updateMergedData(action.payload.entityId, tenantId, { mergedData, provenance });

  return {
    applied: true,
    stateChanges: [{
      path: `entity.${action.payload.fieldName}`,
      before: action.payload.currentValue,
      after: action.payload.correctedValue,
    }],
  };
}

async function applyMatchEntities(
  action: Extract<PipelineAction, { type: 'match_entities' }>,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const links = action.payload.extractionIds.map((extractionId) => ({
    entityId: action.payload.entityId,
    extractionId,
    matchConfidence: action.confidence,
  }));

  await deps.entitySourceRepo.bulkLink(links);

  logger.debug(
    { entityId: action.payload.entityId, extractionCount: links.length },
    'entity-extraction links created',
  );

  return { applied: true };
}

async function applySplitEntities(
  action: Extract<PipelineAction, { type: 'split_entities' }>,
  _tenantId: string,
  _deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  // Split entities requires creating new entities and re-linking extractions.
  // This is a complex operation deferred to a future iteration.
  logger.warn(
    { entityId: action.payload.entityId, groupCount: action.payload.newGroups.length },
    'split_entities not yet implemented — action deferred',
  );
  return { applied: false, reason: 'split_entities not yet implemented' };
}

async function applySetSourceTrust(
  action: Extract<PipelineAction, { type: 'set_source_trust' }>,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  for (const ranking of action.payload.rankings) {
    await deps.sourceTrustRepo.upsert({
      jobId: action.jobId,
      tenantId,
      domain: ranking.domain,
      trustLevel: ranking.trustLevel,
      reasoning: ranking.reasoning,
    });
  }

  return { applied: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/reconciliation-applier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/reconciliation-applier.ts packages/core/tests/unit/execution/reconciliation-applier.test.ts
git commit -m "feat(core): add reconciliation applier for entity mutation actions"
```

---

## Task 6: Finalization Applier

**Files:**
- Create: `packages/core/src/execution/finalization-applier.ts`
- Create: `packages/core/tests/unit/execution/finalization-applier.test.ts`

Applies `recommend_table_structure`, `derive_field`, `flag_anomaly`, and `generate_documentation`. These store metadata — they don't mutate schema or entity data directly.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/finalization-applier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  applyFinalizationAction,
  type FinalizationResult,
} from '../../../src/execution/finalization-applier.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'quality_audit',
    reasoning: 'test',
    confidence: 0.9,
  };
}

describe('applyFinalizationAction', () => {
  it('recommend_table_structure returns metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'recommend_table_structure',
      payload: {
        strategy: 'multi_table',
        tables: [
          { name: 'products', description: 'Main products', fields: ['name', 'price'], relationship: 'primary' },
          { name: 'reviews', description: 'Product reviews', fields: ['rating', 'text'], relationship: 'child', foreignKey: 'product_id' },
        ],
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.tableStructure).toBeDefined();
    expect(result.metadata!.tableStructure!.strategy).toBe('multi_table');
    expect(result.metadata!.tableStructure!.tables).toHaveLength(2);
  });

  it('derive_field returns derivation metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'derive_field',
      payload: {
        fieldName: 'price_per_unit',
        fieldDefinition: { name: 'price_per_unit', description: 'Price per unit', type: 'number', required: false },
        derivedFrom: ['price', 'quantity'],
        derivationLogic: 'price / quantity',
        examples: [{ inputs: { price: 10, quantity: 2 }, output: 5 }],
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.derivedField).toBeDefined();
    expect(result.metadata!.derivedField!.fieldName).toBe('price_per_unit');
  });

  it('flag_anomaly returns anomaly record', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'flag_anomaly',
      payload: {
        entityId: generateId(),
        fieldName: 'price',
        anomalyType: 'outlier_value',
        description: 'Price is 10x higher than median',
        suggestedFix: 99.99,
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.anomaly).toBeDefined();
    expect(result.metadata!.anomaly!.anomalyType).toBe('outlier_value');
  });

  it('generate_documentation returns documentation metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'generate_documentation',
      payload: {
        dataDictionary: [
          {
            fieldName: 'name',
            description: 'Product name',
            exampleValues: ['Widget A', 'Widget B'],
            coveragePercent: 0.95,
            sources: ['site-a.com'],
          },
        ],
        categoryBreakdown: [
          { category: 'electronics', count: 50, specificFields: ['voltage'] },
        ],
        qualitySummary: {
          totalEntities: 100,
          totalSources: 5,
          averageFieldCompleteness: 0.85,
          anomaliesFound: 3,
          anomaliesResolved: 2,
        },
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.documentation).toBeDefined();
  });

  it('returns applied=false for non-finalization action', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: { name: 'x', description: 'x', type: 'string', required: false },
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = applyFinalizationAction(action);
    expect(result.applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/finalization-applier.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement finalization-applier.ts**

Create `packages/core/src/execution/finalization-applier.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';

const logger = createLogger('finalization-applier');

export interface FinalizationMetadata {
  tableStructure?: {
    strategy: string;
    tables: Array<{
      name: string;
      description: string;
      fields: string[];
      relationship?: string;
      foreignKey?: string;
    }>;
  };
  derivedField?: {
    fieldName: string;
    derivedFrom: string[];
    derivationLogic: string;
  };
  anomaly?: {
    entityId?: string;
    fieldName?: string;
    anomalyType: string;
    description: string;
    suggestedFix?: unknown;
  };
  documentation?: {
    dataDictionary: unknown[];
    categoryBreakdown: unknown[];
    qualitySummary: unknown;
  };
}

export interface FinalizationResult {
  applied: boolean;
  reason?: string;
  metadata?: FinalizationMetadata;
}

/**
 * Finalization actions produce metadata rather than mutating schema/entity state.
 * The metadata is stored alongside the action in the action audit log.
 */
export function applyFinalizationAction(action: PipelineAction): FinalizationResult {
  switch (action.type) {
    case 'recommend_table_structure': {
      logger.debug({ strategy: action.payload.strategy }, 'table structure recommendation');
      return {
        applied: true,
        metadata: {
          tableStructure: {
            strategy: action.payload.strategy,
            tables: action.payload.tables.map((t) => ({
              name: t.name,
              description: t.description,
              fields: [...t.fields],
              ...(t.relationship ? { relationship: t.relationship } : {}),
              ...(t.foreignKey ? { foreignKey: t.foreignKey } : {}),
            })),
          },
        },
      };
    }

    case 'derive_field': {
      logger.debug({ fieldName: action.payload.fieldName }, 'derived field recorded');
      return {
        applied: true,
        metadata: {
          derivedField: {
            fieldName: action.payload.fieldName,
            derivedFrom: [...action.payload.derivedFrom],
            derivationLogic: action.payload.derivationLogic,
          },
        },
      };
    }

    case 'flag_anomaly': {
      logger.debug({ anomalyType: action.payload.anomalyType }, 'anomaly flagged');
      return {
        applied: true,
        metadata: {
          anomaly: {
            entityId: action.payload.entityId,
            fieldName: action.payload.fieldName,
            anomalyType: action.payload.anomalyType,
            description: action.payload.description,
            suggestedFix: action.payload.suggestedFix,
          },
        },
      };
    }

    case 'generate_documentation': {
      logger.debug('documentation generation recorded');
      return {
        applied: true,
        metadata: {
          documentation: {
            dataDictionary: action.payload.dataDictionary,
            categoryBreakdown: action.payload.categoryBreakdown,
            qualitySummary: action.payload.qualitySummary,
          },
        },
      };
    }

    default:
      return { applied: false, reason: `Not a finalization action: ${action.type}` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/finalization-applier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/finalization-applier.ts packages/core/tests/unit/execution/finalization-applier.test.ts
git commit -m "feat(core): add finalization applier for metadata-producing actions"
```

---

## Task 7: Review Queue

**Files:**
- Create: `packages/core/src/execution/review-queue.ts`
- Create: `packages/core/tests/unit/execution/review-queue.test.ts`

A logical queue (backed by ActionRepository) that bridges the executor with the CLI Review Mode and API action endpoints.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/review-queue.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultReviewQueue } from '../../../src/execution/review-queue.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import type { ActionPreview } from '../../../src/interfaces/action-executor.js';
import { generateId } from '@spatula/shared';

function baseAction(): PipelineAction {
  return {
    id: generateId(),
    jobId: 'job-1',
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.8,
    type: 'add_field',
    payload: {
      field: { name: 'price', description: 'Price', type: 'number', required: false },
      relevance: {
        globalFrequency: 0.8,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
  };
}

function makePreview(): ActionPreview {
  return {
    actionId: generateId(),
    wouldChange: [{ path: 'schema.fields', before: [], after: [{ name: 'price' }] }],
    riskLevel: 'low',
    requiresApproval: true,
  };
}

function createMockActionRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'action-1' }),
    findByJob: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue({ id: 'action-1', status: 'approved' }),
    batchUpdateStatus: vi.fn().mockResolvedValue([]),
  };
}

function createMockSchemaApplier() {
  return vi.fn().mockReturnValue({ version: 2, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: 1 });
}

describe('DefaultReviewQueue', () => {
  let actionRepo: ReturnType<typeof createMockActionRepo>;
  let queue: DefaultReviewQueue;

  beforeEach(() => {
    actionRepo = createMockActionRepo();
    queue = new DefaultReviewQueue(actionRepo as any);
  });

  describe('enqueue', () => {
    it('creates action with pending_review status and correct tenantId', async () => {
      const action = baseAction();
      const preview = makePreview();

      await queue.enqueue(action, 'tenant-1', preview);

      expect(actionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          tenantId: 'tenant-1',
          type: 'add_field',
          status: 'pending_review',
        }),
      );
    });

    it('stores preview data in payload', async () => {
      const action = baseAction();
      const preview = makePreview();

      await queue.enqueue(action, 'tenant-1', preview);

      const createArg = actionRepo.create.mock.calls[0][0];
      expect(createArg.payload).toHaveProperty('_preview');
    });
  });

  describe('getPending', () => {
    it('fetches pending_review actions for a job', async () => {
      actionRepo.findByJob.mockResolvedValue([
        { id: 'a-1', type: 'add_field', status: 'pending_review' },
      ]);

      const pending = await queue.getPending('job-1', 'tenant-1');

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
      });
      expect(pending).toHaveLength(1);
    });

    it('supports filtering by type', async () => {
      await queue.getPending('job-1', 'tenant-1', { type: 'merge_fields' });

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
        type: 'merge_fields',
      });
    });

    it('supports limit option', async () => {
      await queue.getPending('job-1', 'tenant-1', { limit: 10 });

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
        limit: 10,
      });
    });
  });

  describe('approve', () => {
    it('updates status to approved', async () => {
      actionRepo.updateStatus.mockResolvedValue({ id: 'a-1', status: 'approved' });

      await queue.approve('a-1', 'tenant-1', 'user@example.com');

      expect(actionRepo.updateStatus).toHaveBeenCalledWith('a-1', 'tenant-1', 'approved', 'user@example.com');
    });
  });

  describe('reject', () => {
    it('updates status to rejected', async () => {
      await queue.reject('a-1', 'tenant-1', 'user@example.com', 'Not needed');

      expect(actionRepo.updateStatus).toHaveBeenCalledWith('a-1', 'tenant-1', 'rejected', 'user@example.com');
    });
  });

  describe('approveAll', () => {
    it('approves all pending actions for a job', async () => {
      actionRepo.findByJob.mockResolvedValue([
        { id: 'a-1', status: 'pending_review' },
        { id: 'a-2', status: 'pending_review' },
      ]);
      actionRepo.batchUpdateStatus.mockResolvedValue([
        { id: 'a-1', status: 'approved' },
        { id: 'a-2', status: 'approved' },
      ]);

      const results = await queue.approveAll('job-1', 'tenant-1', 'user@example.com');

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
      });
      expect(actionRepo.batchUpdateStatus).toHaveBeenCalledWith(
        ['a-1', 'a-2'],
        'tenant-1',
        'approved',
        'user@example.com',
      );
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no pending actions exist', async () => {
      actionRepo.findByJob.mockResolvedValue([]);

      const results = await queue.approveAll('job-1', 'tenant-1', 'user@example.com');
      expect(results).toHaveLength(0);
      expect(actionRepo.batchUpdateStatus).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/review-queue.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement review-queue.ts**

Create `packages/core/src/execution/review-queue.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';
import type { ActionPreview } from '../interfaces/action-executor.js';

const logger = createLogger('review-queue');

/**
 * Minimal ActionRepository interface to avoid importing the concrete @spatula/db class.
 */
export interface ReviewQueueActionRepo {
  create(input: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    source: string;
    status: string;
    confidence: number;
    reasoning: string;
    stateChanges?: Record<string, unknown>;
  }): Promise<{ id: string }>;

  findByJob(
    jobId: string,
    tenantId: string,
    options?: { type?: string; status?: string; limit?: number; offset?: number },
  ): Promise<Array<{ id: string; [key: string]: unknown }>>;

  updateStatus(
    actionId: string,
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown>;

  batchUpdateStatus(
    actionIds: string[],
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown[]>;
}

export interface ReviewQueue {
  enqueue(action: PipelineAction, tenantId: string, preview: ActionPreview): Promise<void>;
  getPending(jobId: string, tenantId: string, options?: { type?: string; limit?: number }): Promise<Array<{ id: string; [key: string]: unknown }>>;
  approve(actionId: string, tenantId: string, reviewedBy: string): Promise<unknown>;
  reject(actionId: string, tenantId: string, reviewedBy: string, reason: string): Promise<void>;
  approveAll(jobId: string, tenantId: string, reviewedBy: string): Promise<unknown[]>;
}

export class DefaultReviewQueue implements ReviewQueue {
  constructor(private readonly actionRepo: ReviewQueueActionRepo) {}

  async enqueue(action: PipelineAction, tenantId: string, preview: ActionPreview): Promise<void> {
    const payload = 'payload' in action ? (action as any).payload : {};

    await this.actionRepo.create({
      jobId: action.jobId,
      tenantId,
      type: action.type,
      payload: { ...payload, _preview: preview },
      source: action.source,
      status: 'pending_review',
      confidence: action.confidence,
      reasoning: action.reasoning,
    });

    logger.debug({ type: action.type, jobId: action.jobId }, 'action enqueued for review');
  }

  async getPending(
    jobId: string,
    tenantId: string,
    options?: { type?: string; limit?: number },
  ): Promise<Array<{ id: string; [key: string]: unknown }>> {
    return this.actionRepo.findByJob(jobId, tenantId, {
      status: 'pending_review',
      ...(options?.type ? { type: options.type } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  async approve(actionId: string, tenantId: string, reviewedBy: string): Promise<unknown> {
    return this.actionRepo.updateStatus(actionId, tenantId, 'approved', reviewedBy);
  }

  async reject(
    actionId: string,
    tenantId: string,
    reviewedBy: string,
    _reason: string,
  ): Promise<void> {
    await this.actionRepo.updateStatus(actionId, tenantId, 'rejected', reviewedBy);
  }

  async approveAll(jobId: string, tenantId: string, reviewedBy: string): Promise<unknown[]> {
    const pending = await this.actionRepo.findByJob(jobId, tenantId, {
      status: 'pending_review',
    });

    if (pending.length === 0) return [];

    const ids = pending.map((a) => a.id);
    return this.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/review-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/review-queue.ts packages/core/tests/unit/execution/review-queue.test.ts
git commit -m "feat(core): add DefaultReviewQueue backed by ActionRepository"
```

---

## Task 8: Action Executor Implementation

**Files:**
- Create: `packages/core/src/execution/action-executor-impl.ts`
- Create: `packages/core/tests/unit/execution/action-executor-impl.test.ts`

The main executor that ties everything together — resolves safety policies, auto-applies or defers to review queue, delegates to domain-specific appliers.

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/execution/action-executor-impl.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultActionExecutor } from '../../../src/execution/action-executor-impl.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(
  overrides: Partial<PipelineAction> = {},
): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: 'job-1',
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.9,
    ...overrides,
  };
}

function createMockDeps() {
  return {
    actionRepo: {
      create: vi.fn().mockResolvedValue({ id: 'action-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue({ id: 'action-1' }),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', description: 'Title', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
      create: vi.fn().mockResolvedValue({ id: 'schema-2' }),
    },
    entityRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'entity-1',
        mergedData: { name: 'Widget' },
        provenance: {},
      }),
      updateMergedData: vi.fn().mockResolvedValue({ id: 'entity-1' }),
    },
    entitySourceRepo: {
      bulkLink: vi.fn().mockResolvedValue([]),
    },
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'st-1' }),
    },
    reviewQueue: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      getPending: vi.fn().mockResolvedValue([]),
      approve: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      approveAll: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('DefaultActionExecutor', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let executor: DefaultActionExecutor;

  beforeEach(() => {
    deps = createMockDeps();
    executor = new DefaultActionExecutor({
      actionRepo: deps.actionRepo as any,
      schemaRepo: deps.schemaRepo as any,
      entityRepo: deps.entityRepo as any,
      entitySourceRepo: deps.entitySourceRepo as any,
      sourceTrustRepo: deps.sourceTrustRepo as any,
      reviewQueue: deps.reviewQueue as any,
      approvalPreset: 'balanced',
      confidenceThreshold: 0.7,
      tenantId: 'tenant-1',
    });
  });

  describe('execute', () => {
    it('auto-applies always_auto action (classify_page)', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.3 }),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('applied');
      expect(deps.actionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'applied' }),
      );
      expect(deps.reviewQueue.enqueue).not.toHaveBeenCalled();
    });

    it('auto-applies auto_above_threshold action when confidence >= threshold', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.8 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('applied');
      expect(deps.reviewQueue.enqueue).not.toHaveBeenCalled();
    });

    it('defers auto_above_threshold action when confidence < threshold', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.5 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
      expect(deps.reviewQueue.enqueue).toHaveBeenCalled();
    });

    it('defers batch_review actions regardless of confidence', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'merge_fields',
        payload: {
          canonicalName: 'name',
          aliasNames: ['title'],
          canonicalDefinition: { name: 'name', description: 'Name', type: 'string', required: true },
          valueMappings: {},
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
      expect(deps.reviewQueue.enqueue).toHaveBeenCalled();
    });

    it('defers always_review actions', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'remove_field',
        payload: { fieldName: 'title', reason: 'irrelevant' },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
    });

    it('auto-applies everything under trust_ai preset', async () => {
      executor = new DefaultActionExecutor({
        actionRepo: deps.actionRepo as any,
        schemaRepo: deps.schemaRepo as any,
        entityRepo: deps.entityRepo as any,
        entitySourceRepo: deps.entitySourceRepo as any,
        sourceTrustRepo: deps.sourceTrustRepo as any,
        reviewQueue: deps.reviewQueue as any,
        approvalPreset: 'trust_ai',
        confidenceThreshold: 0.7,
        tenantId: 'tenant-1',
      });

      const action: PipelineAction = {
        ...baseAction({ confidence: 0.3 }),
        type: 'remove_field',
        payload: { fieldName: 'title', reason: 'irrelevant' },
      };

      const result = await executor.execute(action);
      expect(result.status).toBe('applied');
    });

    it('defers everything under manual preset', async () => {
      executor = new DefaultActionExecutor({
        actionRepo: deps.actionRepo as any,
        schemaRepo: deps.schemaRepo as any,
        entityRepo: deps.entityRepo as any,
        entitySourceRepo: deps.entitySourceRepo as any,
        sourceTrustRepo: deps.sourceTrustRepo as any,
        reviewQueue: deps.reviewQueue as any,
        approvalPreset: 'manual',
        confidenceThreshold: 0.7,
        tenantId: 'tenant-1',
      });

      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const result = await executor.execute(action);
      expect(result.status).toBe('deferred');
    });
  });

  describe('preview', () => {
    it('returns preview with requiresApproval based on policy', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.5 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const preview = await executor.preview(action);

      expect(preview.requiresApproval).toBe(true);
      expect(preview.riskLevel).toBeDefined();
    });

    it('returns requiresApproval=false for always_auto action', async () => {
      const action: PipelineAction = {
        ...baseAction(),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const preview = await executor.preview(action);
      expect(preview.requiresApproval).toBe(false);
    });
  });

  describe('rollback', () => {
    it('throws for reconciliation actions (not supported in v1)', async () => {
      deps.actionRepo.findById.mockResolvedValue({
        id: 'action-1',
        type: 'resolve_conflict',
        status: 'applied',
      });

      await expect(executor.rollback('action-1')).rejects.toThrow('not supported');
    });

    it('throws when action not found', async () => {
      deps.actionRepo.findById.mockResolvedValue(null);

      await expect(executor.rollback('nonexistent')).rejects.toThrow('not found');
    });

    it('throws when action was not applied', async () => {
      deps.actionRepo.findById.mockResolvedValue({
        id: 'action-1',
        type: 'add_field',
        status: 'pending_review',
      });

      await expect(executor.rollback('action-1')).rejects.toThrow('not applied');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/action-executor-impl.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement action-executor-impl.ts**

Create `packages/core/src/execution/action-executor-impl.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';
import type { ActionExecutor, ActionResult, ActionPreview, StateChange } from '../interfaces/action-executor.js';
import { resolvePolicy, shouldAutoApply, type ApprovalPreset } from './safety-policy.js';
import { applySchemaActions } from '../evolution/schema-action-applier.js';
import { applyCategoryActions } from './category-applier.js';
import { applyReconciliationAction, type ReconciliationDeps } from './reconciliation-applier.js';
import { applyFinalizationAction } from './finalization-applier.js';
import type { ReviewQueue } from './review-queue.js';

const logger = createLogger('action-executor');

// Action type categories for domain dispatch
const SCHEMA_ACTION_TYPES = new Set([
  'add_field', 'remove_field', 'modify_field', 'rename_field',
  'merge_fields', 'split_field', 'group_fields',
  'set_normalization_rule', 'update_enum_map',
]);
const CATEGORY_ACTION_TYPES = new Set(['define_category', 'assign_category_fields']);
const CRAWL_ACTION_TYPES = new Set(['classify_page', 'enqueue_links', 'hint_entity_match']);
const RECONCILIATION_ACTION_TYPES = new Set([
  'resolve_conflict', 'infer_value', 'correct_value',
  'match_entities', 'split_entities', 'set_source_trust',
]);
const REPROCESSING_ACTION_TYPES = new Set(['reprocess_extraction']);
const FINALIZATION_ACTION_TYPES = new Set([
  'recommend_table_structure', 'derive_field', 'flag_anomaly', 'generate_documentation',
]);

export interface ActionExecutorConfig {
  actionRepo: {
    create(input: {
      jobId: string;
      tenantId: string;
      type: string;
      payload: Record<string, unknown>;
      source: string;
      status: string;
      confidence: number;
      reasoning: string;
      stateChanges?: Record<string, unknown>;
    }): Promise<{ id: string }>;
    findById(actionId: string, tenantId: string): Promise<{
      id: string;
      type: string;
      status: string;
      stateChanges?: unknown;
      [key: string]: unknown;
    } | null>;
    updateStatus(actionId: string, tenantId: string, status: string): Promise<unknown>;
  };
  schemaRepo: {
    findLatest(jobId: string, tenantId: string): Promise<{
      id: string;
      version: number;
      definition: import('../types/schema.js').SchemaDefinition;
    } | null>;
    create(input: {
      jobId: string;
      tenantId: string;
      version: number;
      definition: import('../types/schema.js').SchemaDefinition;
      parentId?: string;
    }): Promise<unknown>;
  };
  entityRepo: ReconciliationDeps['entityRepo'];
  entitySourceRepo: ReconciliationDeps['entitySourceRepo'];
  sourceTrustRepo: ReconciliationDeps['sourceTrustRepo'];
  reviewQueue: ReviewQueue;
  approvalPreset: ApprovalPreset;
  confidenceThreshold: number;
  tenantId: string;
}

export class DefaultActionExecutor implements ActionExecutor {
  private readonly config: ActionExecutorConfig;

  constructor(config: ActionExecutorConfig) {
    this.config = config;
  }

  async execute(action: PipelineAction): Promise<ActionResult> {
    const { approvalPreset, confidenceThreshold } = this.config;
    const policy = resolvePolicy(action.type, approvalPreset);
    const autoApply = shouldAutoApply(policy, action.confidence, confidenceThreshold);

    if (!autoApply) {
      return this.deferToReview(action);
    }

    return this.applyAction(action);
  }

  async preview(action: PipelineAction): Promise<ActionPreview> {
    const { approvalPreset, confidenceThreshold } = this.config;
    const policy = resolvePolicy(action.type, approvalPreset);
    const requiresApproval = !shouldAutoApply(policy, action.confidence, confidenceThreshold);

    const riskLevel = this.assessRiskLevel(action);

    return {
      actionId: action.id,
      wouldChange: [], // Detailed preview requires running applier in dry-run — simplified for v1
      riskLevel,
      requiresApproval,
    };
  }

  async rollback(actionId: string): Promise<void> {
    const { actionRepo, tenantId } = this.config;
    const action = await actionRepo.findById(actionId, tenantId);

    if (!action) {
      throw new Error(`Action ${actionId} not found`);
    }

    if (action.status !== 'applied') {
      throw new Error(`Action ${actionId} is not applied (status: ${action.status})`);
    }

    // Reconciliation rollback not supported in v1
    if (RECONCILIATION_ACTION_TYPES.has(action.type)) {
      throw new Error(`Rollback of ${action.type} is not supported`);
    }

    // For schema actions, we would reverse the state changes.
    // For v1, we just mark as rolled_back — actual reversal requires
    // storing stateChanges at apply time and replaying them in reverse.
    await actionRepo.updateStatus(actionId, tenantId, 'rolled_back');

    logger.info({ actionId, type: action.type }, 'action rolled back');
  }

  private async applyAction(action: PipelineAction): Promise<ActionResult> {
    const { actionRepo, tenantId } = this.config;
    const stateChanges: StateChange[] = [];

    try {
      if (SCHEMA_ACTION_TYPES.has(action.type)) {
        const changes = await this.applySchemaAction(action);
        stateChanges.push(...changes);
      } else if (CATEGORY_ACTION_TYPES.has(action.type)) {
        const catResult = applyCategoryActions(
          { version: 0, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: null },
          [action],
        );
        if (catResult.categories || catResult.categoryFieldAssignments) {
          stateChanges.push({ path: 'category_metadata', before: null, after: catResult });
        }
      } else if (CRAWL_ACTION_TYPES.has(action.type)) {
        // Crawl actions are no-ops at execution time — produced inline by workers
      } else if (RECONCILIATION_ACTION_TYPES.has(action.type)) {
        const reconcilDeps: ReconciliationDeps = {
          entityRepo: this.config.entityRepo,
          entitySourceRepo: this.config.entitySourceRepo,
          sourceTrustRepo: this.config.sourceTrustRepo,
        };
        const result = await applyReconciliationAction(action, tenantId, reconcilDeps);
        if (result.stateChanges) stateChanges.push(...result.stateChanges);
      } else if (REPROCESSING_ACTION_TYPES.has(action.type)) {
        // Reprocessing: would enqueue extraction jobs — no-op for now
      } else if (FINALIZATION_ACTION_TYPES.has(action.type)) {
        const finResult = applyFinalizationAction(action);
        if (finResult.metadata) {
          stateChanges.push({ path: 'finalization_metadata', before: null, after: finResult.metadata });
        }
      }

      // Persist action with applied status
      const { id: actionId } = await actionRepo.create({
        jobId: action.jobId,
        tenantId,
        type: action.type,
        payload: 'payload' in action ? (action as any).payload : {},
        source: action.source,
        status: 'applied',
        confidence: action.confidence,
        reasoning: action.reasoning,
        stateChanges: stateChanges.length > 0 ? { changes: stateChanges } : undefined,
      });

      logger.debug({ actionId, type: action.type }, 'action applied');

      return {
        actionId,
        status: 'applied',
        stateChanges,
      };
    } catch (error) {
      logger.error({ type: action.type, error }, 'failed to apply action');
      throw error;
    }
  }

  private async deferToReview(action: PipelineAction): Promise<ActionResult> {
    const preview = await this.preview(action);
    await this.config.reviewQueue.enqueue(action, this.config.tenantId, preview);

    return {
      actionId: action.id,
      status: 'deferred',
      stateChanges: [],
    };
  }

  private async applySchemaAction(action: PipelineAction): Promise<StateChange[]> {
    const { schemaRepo, tenantId } = this.config;
    const latestSchema = await schemaRepo.findLatest(action.jobId, tenantId);

    if (!latestSchema) {
      logger.warn({ jobId: action.jobId }, 'no schema found for action application');
      return [];
    }

    const evolved = applySchemaActions(latestSchema.definition, [action]);

    if (evolved.version === latestSchema.definition.version) {
      return []; // No effective change
    }

    await schemaRepo.create({
      jobId: action.jobId,
      tenantId,
      version: evolved.version,
      definition: evolved,
      parentId: latestSchema.id,
    });

    return [{
      path: 'schema.version',
      before: latestSchema.definition.version,
      after: evolved.version,
    }];
  }

  private assessRiskLevel(action: PipelineAction): 'low' | 'medium' | 'high' {
    if (CRAWL_ACTION_TYPES.has(action.type)) return 'low';
    if (FINALIZATION_ACTION_TYPES.has(action.type)) return 'low';
    if (CATEGORY_ACTION_TYPES.has(action.type)) return 'low';

    if (action.type === 'remove_field' || action.type === 'split_entities') return 'high';
    if (action.type === 'merge_fields' || action.type === 'split_field' || action.type === 'group_fields') return 'medium';
    if (action.type === 'resolve_conflict' || action.type === 'correct_value') return 'medium';

    return 'low';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/execution/action-executor-impl.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/execution/action-executor-impl.ts packages/core/tests/unit/execution/action-executor-impl.test.ts
git commit -m "feat(core): add DefaultActionExecutor with policy-driven routing"
```

---

## Task 9: Execution Barrel Exports

**Files:**
- Create: `packages/core/src/execution/index.ts`
- Modify: `packages/core/src/index.ts`

Wire up all execution module exports.

- [ ] **Step 1: Create execution barrel**

Create `packages/core/src/execution/index.ts`:

```typescript
export {
  SAFETY_POLICY_MAP,
  resolvePolicy,
  shouldAutoApply,
  type ApprovalPreset,
} from './safety-policy.js';

export {
  applyCategoryActions,
  type CategoryMetadata,
  type CategoryFieldAssignment,
  type CategoryApplierResult,
} from './category-applier.js';

export {
  applyReconciliationAction,
  type ReconciliationDeps,
  type ReconciliationResult,
} from './reconciliation-applier.js';

export {
  applyFinalizationAction,
  type FinalizationMetadata,
  type FinalizationResult,
} from './finalization-applier.js';

export {
  DefaultReviewQueue,
  type ReviewQueue,
  type ReviewQueueActionRepo,
} from './review-queue.js';

export {
  DefaultActionExecutor,
  type ActionExecutorConfig,
} from './action-executor-impl.js';
```

- [ ] **Step 2: Add execution to core index**

In `packages/core/src/index.ts`, add after the Exporters section:

```typescript
// Execution
export * from './execution/index.js';
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/execution/index.ts packages/core/src/index.ts
git commit -m "feat(core): add execution module barrel exports"
```

---

## Task 10: API Route Integration — ReviewQueue

**Files:**
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/routes/actions.ts`

Update the AppDeps type to include an optional ReviewQueue, then update the action routes to use it for approve/reject/approve-all instead of directly calling `updateStatus`.

- [ ] **Step 1: Add ReviewQueue to AppDeps**

In `apps/api/src/types.ts`, add the import and optional property:

```typescript
import type { ReviewQueue } from '@spatula/core';
```

Add to the `AppDeps` interface:

```typescript
reviewQueue?: ReviewQueue;
```

- [ ] **Step 2: Update action routes to prefer ReviewQueue**

In `apps/api/src/routes/actions.ts`, replace the three mutation routes:

```typescript
// POST /approve-all — Batch approve (MUST be before /:actionId routes)
router.post('/approve-all', async (c) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');
  const jobId = c.req.param('jobId') as string;

  const body = await c.req.json().catch(() => ({}));
  const reviewedBy = body?.reviewedBy;

  // Use ReviewQueue if available (Phase 11b), otherwise direct update
  if (deps.reviewQueue) {
    const results = await deps.reviewQueue.approveAll(jobId, tenantId, reviewedBy);
    return c.json({ data: results });
  }

  const pending = await deps.actionRepo.findByJob(jobId, tenantId, {
    status: 'pending_review',
  });
  const ids = pending.map((a: { id: string }) => a.id);

  if (ids.length === 0) {
    return c.json({ data: [], message: 'No pending actions to approve' });
  }

  const updated = await deps.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
  return c.json({ data: updated });
});

// POST /:actionId/approve
router.post('/:actionId/approve', async (c) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');
  const actionId = c.req.param('actionId');

  const body = await c.req.json().catch(() => ({}));
  const reviewedBy = body?.reviewedBy;

  if (deps.reviewQueue) {
    const action = await deps.reviewQueue.approve(actionId, tenantId, reviewedBy);
    return c.json({ data: action });
  }

  const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'approved', reviewedBy);
  return c.json({ data: action });
});

// POST /:actionId/reject
router.post('/:actionId/reject', async (c) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');
  const actionId = c.req.param('actionId');

  const body = await c.req.json().catch(() => ({}));
  const reviewedBy = body?.reviewedBy;
  const reason = body?.reason ?? '';

  if (deps.reviewQueue) {
    await deps.reviewQueue.reject(actionId, tenantId, reviewedBy, reason);
    return c.json({ data: { id: actionId, status: 'rejected' } });
  }

  const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'rejected', reviewedBy);
  return c.json({ data: action });
});
```

- [ ] **Step 3: Verify all API tests still pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test`
Expected: All tests pass (the ReviewQueue is optional, so existing tests without it use the fallback path).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/types.ts apps/api/src/routes/actions.ts
git commit -m "feat(api): route action approve/reject through ReviewQueue when available"
```

---

## Task 11: Run Full Test Suite & Build

- [ ] **Step 1: Run all unit tests**

```bash
cd /Users/salar/Projects/spatula && pnpm test
```
Expected: All tests pass.

- [ ] **Step 2: Run build**

```bash
cd /Users/salar/Projects/spatula && pnpm build
```
Expected: Build succeeds with no type errors.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/salar/Projects/spatula && pnpm typecheck
```
Expected: No TypeScript errors.

- [ ] **Step 4: Run lint**

```bash
cd /Users/salar/Projects/spatula && pnpm lint
```
Expected: No lint errors.

- [ ] **Step 5: Final commit if any stragglers**

```bash
git status
```

If there are uncommitted changes, create a cleanup commit.
