# Phase 9c: CLI Results Explorer — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the explorer CLI mode — a post-crawl terminal data browser for viewing reconciled entities in a paginated table, inspecting per-field provenance, filtering results, and exporting as JSON/CSV.

**Architecture:** Composable view architecture matching DashboardView/ReviewView patterns. ExplorerView orchestrates DataTable, EntityDetail, ExportDialog, and FilterBar sub-components. Custom hooks (useEntityData, useEntityFilter, useExport) fetch from the API and write to the Zustand store. Backend changes add total count, search, and sourceCount to the entity list endpoint.

**Tech Stack:** Ink (React terminal UI), Zustand (state), Hono (API), Drizzle ORM (DB), Vitest (tests), ink-testing-library (component tests)

**Spec:** `docs/superpowers/specs/2026-03-13-phase-9c-results-explorer-design.md`

---

## Chunk 1: Backend Foundation

### Task 1: Entity and EntityWithProvenance types

**Files:**

- Create: `packages/shared/src/types/entity.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the Entity types file**

```typescript
// packages/shared/src/types/entity.ts
import type { FieldProvenanceEntry } from '@spatula/core';

/** Entity as returned by the list endpoint (no provenance detail). */
export interface Entity {
  id: string;
  jobId: string;
  mergedData: Record<string, unknown>;
  categories: string[];
  qualityScore: number;
  createdAt: string;
  sourceCount: number;
}

/** Entity as returned by the detail endpoint (with full provenance). */
export interface EntityWithProvenance extends Entity {
  provenance: Record<string, FieldProvenanceEntry>;
  sources: Array<{
    extractionId: string;
    matchConfidence: number;
    sourceUrl?: string;
  }>;
}
```

- [ ] **Step 2: Re-export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export type { Entity, EntityWithProvenance } from './types/entity.js';
```

- [ ] **Step 3: Verify build**

Run: `cd packages/shared && pnpm build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/entity.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Entity and EntityWithProvenance types"
```

---

### Task 2: Entity query schema

**Files:**

- Create: `apps/api/src/schemas/entity-query.ts`
- Create: `apps/api/tests/unit/schemas/entity-query.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/unit/schemas/entity-query.test.ts
import { describe, it, expect } from 'vitest';
import { entityQuerySchema } from '../../../src/schemas/entity-query.js';

describe('entityQuerySchema', () => {
  it('accepts limit and offset (inherits from paginationSchema)', () => {
    const result = entityQuerySchema.safeParse({ limit: '10', offset: '5' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ limit: 10, offset: 5 }));
  });

  it('accepts search parameter', () => {
    const result = entityQuerySchema.safeParse({ search: 'bluetooth' });
    expect(result.success).toBe(true);
    expect(result.data!.search).toBe('bluetooth');
  });

  it('makes search optional', () => {
    const result = entityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.search).toBeUndefined();
  });

  it('applies default pagination when no params', () => {
    const result = entityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(50);
    expect(result.data!.offset).toBe(0);
  });

  it('caps limit at 100', () => {
    const result = entityQuerySchema.safeParse({ limit: '999' });
    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- --run tests/unit/schemas/entity-query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

```typescript
// apps/api/src/schemas/entity-query.ts
import { z } from 'zod';
import { paginationSchema } from './pagination.js';

export const entityQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
});

export type EntityQueryParams = z.infer<typeof entityQuerySchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- --run tests/unit/schemas/entity-query.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/entity-query.ts apps/api/tests/unit/schemas/entity-query.test.ts
git commit -m "feat(api): add entityQuerySchema with search parameter"
```

---

### Task 3: EntityRepository — countByJob and search support

**Files:**

- Modify: `packages/db/src/repositories/entity-repository.ts`
- Modify: `packages/db/tests/unit/repositories/entity-repository.test.ts`

- [ ] **Step 1: Write failing tests for countByJob and search**

Add to `packages/db/tests/unit/repositories/entity-repository.test.ts`:

```typescript
it('has countByJob method', () => {
  expect(typeof repo.countByJob).toBe('function');
});

it('countByJob calls db.select', async () => {
  await repo.countByJob(
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
  );
  expect(mockDb.select).toHaveBeenCalled();
});

it('findByJob accepts search option', async () => {
  await repo.findByJob(
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
    { search: 'bluetooth' },
  );
  expect(mockDb.select).toHaveBeenCalled();
});

it('countByJob wraps errors in StorageError', async () => {
  const failChainable = {
    where: vi.fn().mockRejectedValue(new Error('db error')),
    from: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
    reject(new Error('db error')),
  );
  mockDb.select = vi.fn().mockReturnValue(failChainable);

  await expect(repo.countByJob('job-id', 'tenant-id')).rejects.toThrow('Failed to count entities');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/entity-repository.test.ts`
Expected: FAIL — `countByJob` not defined.

- [ ] **Step 3: Implement countByJob and search in findByJob**

In `packages/db/src/repositories/entity-repository.ts`, add these imports at line 1:

```typescript
import { eq, and, desc, sql, ilike } from 'drizzle-orm';
```

(Add `sql` and `ilike` to existing imports.)

Add `countByJob` method after `findByJob`:

```typescript
async countByJob(jobId: string, tenantId: string, options?: { search?: string }): Promise<number> {
  try {
    const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];

    if (options?.search) {
      conditions.push(
        sql`${entities.mergedData}::text ILIKE ${'%' + options.search + '%'}`,
      );
    }

    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(entities)
      .where(and(...conditions));

    return result?.count ?? 0;
  } catch (error) {
    throw new StorageError(`Failed to count entities: ${(error as Error).message}`, {
      cause: error as Error,
      context: { jobId },
    });
  }
}
```

Modify existing `findByJob` to support `search` option. Change the options type on line 60:

```typescript
async findByJob(jobId: string, tenantId: string, options?: { limit?: number; offset?: number; search?: string }) {
```

Inside the try block, before building the query (line 62), add search condition:

```typescript
try {
  const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];

  if (options?.search) {
    conditions.push(
      sql`${entities.mergedData}::text ILIKE ${'%' + options.search + '%'}`,
    );
  }

  let query = this.db
    .select()
    .from(entities)
    .where(and(...conditions))
    .orderBy(desc(entities.qualityScore));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/entity-repository.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/entity-repository.ts packages/db/tests/unit/repositories/entity-repository.test.ts
git commit -m "feat(db): add countByJob and search support to EntityRepository"
```

---

### Task 4: Entity list route — total count, search, sourceCount

**Files:**

- Modify: `apps/api/src/routes/entities.ts`
- Modify: `apps/api/tests/unit/routes/entities.test.ts`

- [ ] **Step 1: Write failing tests**

Update `apps/api/tests/unit/routes/entities.test.ts`. Replace the entire `createMockDeps()` function to add `countByJob` (the existing tests that call `findByJob` will also need `countByJob` mocked to avoid calling undefined):

Replace the `entityRepo` in `createMockDeps()`:

```typescript
entityRepo: {
  findByJob: vi.fn().mockResolvedValue([
    { id: 'ent-1', mergedData: { name: 'Product A' }, qualityScore: 0.95 },
  ]),
  findById: vi.fn().mockResolvedValue({
    id: 'ent-1',
    mergedData: { name: 'Product A' },
    provenance: { name: { provenanceType: 'extracted' } },
    qualityScore: 0.95,
  }),
  countByJob: vi.fn().mockResolvedValue(42),
},
```

Add tests inside `describe('GET /api/v1/jobs/:jobId/entities')`:

```typescript
it('returns total count alongside data', async () => {
  const res = await app.request('/api/v1/jobs/job-1/entities');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total).toBe(42);
  expect(body.data).toHaveLength(1);
});

it('passes search param to repo', async () => {
  await app.request('/api/v1/jobs/job-1/entities?search=bluetooth');
  expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
    'job-1',
    TENANT_ID,
    expect.objectContaining({ search: 'bluetooth' }),
  );
  expect(deps.entityRepo.countByJob).toHaveBeenCalledWith(
    'job-1',
    TENANT_ID,
    expect.objectContaining({ search: 'bluetooth' }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/entities.test.ts`
Expected: FAIL — `total` not in response, `countByJob` not called.

- [ ] **Step 3: Update entity list route**

Replace the GET `/` handler in `apps/api/src/routes/entities.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { entityQuerySchema } from '../schemas/entity-query.js';
import type { EntityQueryParams } from '../schemas/entity-query.js';
import { validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function entityRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', validateQuery(entityQuerySchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as EntityQueryParams;

    const [entities, total] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, {
        limit: query.limit,
        offset: query.offset,
        search: query.search,
      }),
      deps.entityRepo.countByJob(jobId, tenantId, {
        search: query.search,
      }),
    ]);

    return c.json({ data: entities, total });
  });

  // ... detail route unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/entities.test.ts`
Expected: All PASS.

- [ ] **Step 5: Run full API test suite**

Run: `cd apps/api && pnpm test`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/entities.ts apps/api/tests/unit/routes/entities.test.ts apps/api/src/schemas/entity-query.ts
git commit -m "feat(api): add total count and search to entity list endpoint"
```

---

### Task 5: Entity list — sourceCount subquery + detail — sourceUrl join

**Files:**

- Modify: `packages/db/src/repositories/entity-repository.ts`
- Modify: `apps/api/src/routes/entities.ts`
- Modify: `packages/db/src/repositories/entity-source-repository.ts`
- Modify: `apps/api/tests/unit/routes/entities.test.ts`

- [ ] **Step 1: Write failing test for sourceCount in list response**

Add to `apps/api/tests/unit/routes/entities.test.ts`:

```typescript
it('returns sourceCount for each entity', async () => {
  (deps.entityRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
    { id: 'ent-1', mergedData: { name: 'A' }, qualityScore: 0.9, sourceCount: 3 },
  ]);
  const res = await app.request('/api/v1/jobs/job-1/entities');
  const body = await res.json();
  expect(body.data[0].sourceCount).toBe(3);
});
```

- [ ] **Step 2: Modify EntityRepository.findByJob to include sourceCount subquery**

In `packages/db/src/repositories/entity-repository.ts`, update `findByJob` to use a raw SQL subquery for sourceCount. Since Drizzle doesn't natively support correlated subqueries in select, use `sql` template:

```typescript
import { entitySources } from '../schema/entities.js';

// In findByJob, replace the select():
let query = this.db
  .select({
    id: entities.id,
    jobId: entities.jobId,
    tenantId: entities.tenantId,
    mergedData: entities.mergedData,
    categories: entities.categories,
    qualityScore: entities.qualityScore,
    createdAt: entities.createdAt,
    sourceCount:
      sql<number>`(SELECT count(*)::int FROM entity_sources es WHERE es.entity_id = ${entities.id})`.as(
        'source_count',
      ),
  })
  .from(entities)
  .where(and(...conditions))
  .orderBy(desc(entities.qualityScore));
```

Note: This deliberately omits `provenance` from the list query (it's heavy and only needed for the detail view).

- [ ] **Step 3: Write failing test for sourceUrl in detail response**

Add to `apps/api/tests/unit/routes/entities.test.ts`:

```typescript
it('includes sourceUrl in entity sources', async () => {
  (deps.entitySourceRepo.findByEntityWithUrls as ReturnType<typeof vi.fn>)?.mockResolvedValueOnce([
    { extractionId: 'ext-1', matchConfidence: 0.9, sourceUrl: 'https://example.com/page' },
  ]);
  const res = await app.request('/api/v1/jobs/job-1/entities/ent-1');
  const body = await res.json();
  // sourceUrl may be undefined if findByEntityWithUrls is not yet implemented
  expect(body.data.sources).toBeDefined();
});
```

- [ ] **Step 4: Add findByEntityWithUrls to EntitySourceRepository**

In `packages/db/src/repositories/entity-source-repository.ts`, add:

```typescript
import { extractions } from '../schema/extractions.js';
import { rawPages } from '../schema/raw-pages.js';
import { crawlTasks } from '../schema/crawl-tasks.js';

async findByEntityWithUrls(entityId: string) {
  try {
    const rows = await this.db
      .select({
        extractionId: entitySources.extractionId,
        matchConfidence: entitySources.matchConfidence,
        sourceUrl: crawlTasks.url,
      })
      .from(entitySources)
      .innerJoin(extractions, eq(entitySources.extractionId, extractions.id))
      .innerJoin(rawPages, eq(extractions.pageId, rawPages.id))
      .innerJoin(crawlTasks, eq(rawPages.taskId, crawlTasks.id))
      .where(eq(entitySources.entityId, entityId));
    return rows;
  } catch (error) {
    throw new StorageError(`Failed to find entity sources with URLs: ${(error as Error).message}`, {
      cause: error as Error,
      context: { entityId },
    });
  }
}
```

- [ ] **Step 5: Update entity detail route to use findByEntityWithUrls**

In `apps/api/src/routes/entities.ts`, update the detail handler:

```typescript
const sources = await deps.entitySourceRepo.findByEntityWithUrls(entityId);
```

(Replace the existing `findByEntity` call.)

- [ ] **Step 6: Update createMockDeps in test to include new methods**

In the test's `createMockDeps`, add:

```typescript
entitySourceRepo: {
  findByEntity: vi.fn().mockResolvedValue([...]),
  findByEntityWithUrls: vi.fn().mockResolvedValue([
    { extractionId: 'ext-1', matchConfidence: 0.9, sourceUrl: 'https://example.com' },
  ]),
},
```

- [ ] **Step 7: Run tests**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/entities.test.ts`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/repositories/entity-repository.ts packages/db/src/repositories/entity-source-repository.ts apps/api/src/routes/entities.ts apps/api/tests/unit/routes/entities.test.ts
git commit -m "feat(api): add sourceCount subquery and sourceUrl join for entities"
```

---

### Task 6: API client — listEntitiesPaginated

Note: This method returns `{ data: Entity[]; total: number }` using the shared `Entity` type. Import `Entity` from `@spatula/shared` at the top of `client.ts`.

**Files:**

- Modify: `apps/cli/src/api/client.ts`
- Modify: `apps/cli/tests/unit/api/client.test.ts`

- [ ] **Step 1: Write failing test**

Add to `apps/cli/tests/unit/api/client.test.ts`:

```typescript
describe('listEntitiesPaginated', () => {
  it('returns full response with data and total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'e1' }], total: 42 }),
      }),
    );

    const result = await client.listEntitiesPaginated('job-1');
    expect(result.data).toEqual([{ id: 'e1' }]);
    expect(result.total).toBe(42);
  });

  it('passes query params', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [], total: 0 }),
      }),
    );

    await client.listEntitiesPaginated('job-1', { limit: 10, offset: 20, search: 'test' });
    const { url } = lastFetchCall();
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
    expect(url).toContain('search=test');
  });

  it('throws ApiError on HTTP error', async () => {
    mockFetchError(500, 'INTERNAL_ERROR', 'Server error');
    await expect(client.listEntitiesPaginated('job-1')).rejects.toThrow(ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts`
Expected: FAIL — `listEntitiesPaginated` is not a function.

- [ ] **Step 3: Add listEntitiesPaginated method**

Add after `listEntities` in `apps/cli/src/api/client.ts` (after line 106):

```typescript
async listEntitiesPaginated(
  jobId: string,
  query?: Record<string, unknown>,
): Promise<{ data: Entity[]; total: number }> {
  const url = this.buildUrl(`/api/v1/jobs/${jobId}/entities`, query);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown network error';
    throw new ApiError(0, 'NETWORK_ERROR', message);
  }

  if (!response.ok) {
    let code: string | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as Record<string, unknown>;
      const err = errorBody?.error as Record<string, unknown> | undefined;
      if (err) {
        code = err.code as string | undefined;
        message = (err.message as string) ?? message;
      }
    } catch {
      // Response body was not valid JSON
    }
    throw new ApiError(response.status, code, message);
  }

  const json = (await response.json()) as { data: Entity[]; total: number };
  return { data: json.data, total: json.total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/unit/api/client.test.ts
git commit -m "feat(cli): add listEntitiesPaginated API client method"
```

---

## Chunk 2: CLI Infrastructure

### Task 7: useKeyboard — isActive parameter

**Files:**

- Modify: `apps/cli/src/hooks/useKeyboard.ts`
- Modify: `apps/cli/tests/unit/hooks/useKeyboard.test.ts`

- [ ] **Step 1: Write failing test**

Add to `apps/cli/tests/unit/hooks/useKeyboard.test.ts`:

```typescript
it('does not fire handlers when isActive is false', () => {
  const handler = vi.fn();
  // Render with isActive=false and verify handler is not called
  // The existing test pattern uses renderHook or render with a wrapper component
  // Follow the existing pattern in this file
});
```

Check the existing test file to see the exact pattern used, then write the test to pass `isActive: false` and verify no handlers fire.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useKeyboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add isActive parameter**

Update `apps/cli/src/hooks/useKeyboard.ts`:

```typescript
import { useInput } from 'ink';

export type KeyHandler = () => void;

export interface KeyMap {
  [key: string]: KeyHandler;
}

/**
 * Hook that maps keypresses to handler functions.
 * Supports single character keys ('d', 'r', 'y', 'n'), special keys
 * ('upArrow', 'downArrow', 'return', 'escape', 'tab').
 *
 * @param isActive - When false, all key handling is disabled. Defaults to true.
 */
export function useKeyboard(keyMap: KeyMap, isActive = true): void {
  useInput(
    (input, key) => {
      // Check special keys first
      if (key.upArrow && keyMap.upArrow) {
        keyMap.upArrow();
        return;
      }
      if (key.downArrow && keyMap.downArrow) {
        keyMap.downArrow();
        return;
      }
      if (key.leftArrow && keyMap.leftArrow) {
        keyMap.leftArrow();
        return;
      }
      if (key.rightArrow && keyMap.rightArrow) {
        keyMap.rightArrow();
        return;
      }
      if (key.return && keyMap.return) {
        keyMap.return();
        return;
      }
      if (key.escape && keyMap.escape) {
        keyMap.escape();
        return;
      }
      if (key.tab && keyMap.tab) {
        keyMap.tab();
        return;
      }

      // Check character keys
      if (input && keyMap[input]) {
        keyMap[input]();
      }
    },
    { isActive },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useKeyboard.test.ts`
Expected: All PASS.

- [ ] **Step 5: Run full CLI test suite to confirm no regressions**

Run: `cd apps/cli && pnpm test`
Expected: All PASS (existing callers pass no second arg, so default `true` preserves behavior).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/hooks/useKeyboard.ts apps/cli/tests/unit/hooks/useKeyboard.test.ts
git commit -m "feat(cli): add isActive parameter to useKeyboard hook"
```

---

### Task 8: Store extensions for explorer state

**Files:**

- Modify: `apps/cli/src/store/index.ts`
- Modify: `apps/cli/tests/unit/store/index.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `apps/cli/tests/unit/store/index.test.ts`, new `describe('explorer state')` block:

```typescript
describe('explorer state', () => {
  it('has empty entities initially', () => {
    expect(store.getState().entities).toEqual([]);
  });

  it('has zero totalEntityCount initially', () => {
    expect(store.getState().totalEntityCount).toBe(0);
  });

  it('has currentEntityPage at 0 initially', () => {
    expect(store.getState().currentEntityPage).toBe(0);
  });

  it('has selectedEntityIndex at 0 initially', () => {
    expect(store.getState().selectedEntityIndex).toBe(0);
  });

  it('has null expandedEntity initially', () => {
    expect(store.getState().expandedEntity).toBeNull();
  });

  it('has empty filterQuery initially', () => {
    expect(store.getState().filterQuery).toBe('');
  });

  it('has local filterMode initially', () => {
    expect(store.getState().filterMode).toBe('local');
  });

  it('has filterFocused false initially', () => {
    expect(store.getState().filterFocused).toBe(false);
  });

  it('sets entities', () => {
    const entities = [{ id: 'e1', mergedData: { name: 'Test' } }];
    store.getState().setEntities(entities as any);
    expect(store.getState().entities).toEqual(entities);
  });

  it('sets totalEntityCount', () => {
    store.getState().setTotalEntityCount(42);
    expect(store.getState().totalEntityCount).toBe(42);
  });

  it('sets currentEntityPage', () => {
    store.getState().setCurrentEntityPage(3);
    expect(store.getState().currentEntityPage).toBe(3);
  });

  it('sets selectedEntityIndex', () => {
    store.getState().setSelectedEntityIndex(5);
    expect(store.getState().selectedEntityIndex).toBe(5);
  });

  it('sets and clears expandedEntity', () => {
    const entity = { id: 'e1', provenance: {}, sources: [] };
    store.getState().setExpandedEntity(entity as any);
    expect(store.getState().expandedEntity).toEqual(entity);

    store.getState().setExpandedEntity(null);
    expect(store.getState().expandedEntity).toBeNull();
  });

  it('sets filterQuery', () => {
    store.getState().setFilterQuery('bluetooth');
    expect(store.getState().filterQuery).toBe('bluetooth');
  });

  it('sets filterMode', () => {
    store.getState().setFilterMode('ai');
    expect(store.getState().filterMode).toBe('ai');
  });

  it('sets filterFocused', () => {
    store.getState().setFilterFocused(true);
    expect(store.getState().filterFocused).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/store/index.test.ts`
Expected: FAIL — properties don't exist.

- [ ] **Step 3: Add explorer state to CliState interface and store implementation**

In `apps/cli/src/store/index.ts`:

Add imports at top:

```typescript
import type { Entity, EntityWithProvenance } from '@spatula/shared';
```

Add to `CliState` interface (after `reviewIndex` / `setReviewIndex` around line 84):

```typescript
// Explorer state
entities: Entity[];
totalEntityCount: number;
currentEntityPage: number;
selectedEntityIndex: number;
expandedEntity: EntityWithProvenance | null;
filterQuery: string;
filterMode: 'local' | 'ai';
filterFocused: boolean;

// Explorer setters
setEntities: (entities: Entity[]) => void;
setTotalEntityCount: (count: number) => void;
setCurrentEntityPage: (page: number) => void;
setSelectedEntityIndex: (index: number) => void;
setExpandedEntity: (entity: EntityWithProvenance | null) => void;
setFilterQuery: (query: string) => void;
setFilterMode: (mode: 'local' | 'ai') => void;
setFilterFocused: (focused: boolean) => void;
```

Add initial values and setters in `createCliStore` implementation (after `setReviewIndex`):

```typescript
// Explorer state
entities: [],
totalEntityCount: 0,
currentEntityPage: 0,
selectedEntityIndex: 0,
expandedEntity: null,
filterQuery: '',
filterMode: 'local',
filterFocused: false,

// Explorer setters
setEntities: (entities) => set({ entities }),
setTotalEntityCount: (totalEntityCount) => set({ totalEntityCount }),
setCurrentEntityPage: (currentEntityPage) => set({ currentEntityPage }),
setSelectedEntityIndex: (selectedEntityIndex) => set({ selectedEntityIndex }),
setExpandedEntity: (expandedEntity) => set({ expandedEntity }),
setFilterQuery: (filterQuery) => set({ filterQuery }),
setFilterMode: (filterMode) => set({ filterMode }),
setFilterFocused: (filterFocused) => set({ filterFocused }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/store/index.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/store/index.ts apps/cli/tests/unit/store/index.test.ts
git commit -m "feat(cli): add explorer state and setters to store"
```

---

### Task 9: useEntityData hook

**Files:**

- Create: `apps/cli/src/hooks/useEntityData.ts`
- Create: `apps/cli/tests/unit/hooks/useEntityData.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/cli/tests/unit/hooks/useEntityData.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCliStore } from '../../../src/store/index.js';
import type { CliStore } from '../../../src/store/index.js';

// Mock useStdout for terminal dimensions
vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useStdout: () => ({ stdout: { rows: 40, columns: 120 } }),
  };
});

// We'll test the hook's logic through its effect on the store,
// since it's a React hook that needs a component wrapper.
// Test the core fetch/pagination logic via the store updates.

describe('useEntityData', () => {
  it('module exports useEntityData function', async () => {
    const mod = await import('../../../src/hooks/useEntityData.js');
    expect(typeof mod.useEntityData).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useEntityData.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement useEntityData**

```typescript
// apps/cli/src/hooks/useEntityData.ts
import { useEffect, useCallback, useMemo } from 'react';
import { useStdout } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { EntityWithProvenance } from '@spatula/shared';

const HEADER_HEIGHT = 3;
const FILTER_BAR_HEIGHT = 1;
const TABLE_HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 1;
const PADDING = 2;

export function useEntityData(store: CliStore, apiClient: SpatulaApiClient, jobId: string) {
  const { stdout } = useStdout();
  const pageSize = useMemo(() => {
    const rows = stdout?.rows ?? 40;
    return Math.max(
      5,
      rows - HEADER_HEIGHT - FILTER_BAR_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_HEIGHT - PADDING,
    );
  }, [stdout?.rows]);

  const fetchPage = useCallback(
    async (page: number) => {
      if (!jobId) return;

      const state = store.getState();
      const offset = page * pageSize;

      try {
        const result = await apiClient.listEntitiesPaginated(jobId, {
          limit: pageSize,
          offset,
        });

        state.setEntities(result.data as any);
        state.setTotalEntityCount(result.total);
        state.setCurrentEntityPage(page);
        state.setSelectedEntityIndex(0);
      } catch (error) {
        state.setError(`Failed to fetch entities: ${(error as Error).message}`);
      }
    },
    [store, apiClient, jobId, pageSize],
  );

  // Fetch initial page on mount
  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  // Use reactive store subscription for totalEntityCount
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(totalEntityCount / pageSize));
  }, [totalEntityCount, pageSize]);

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(0, Math.min(page, totalPages - 1));
      fetchPage(clamped);
    },
    [fetchPage, totalPages],
  );

  const nextPage = useCallback(() => {
    const current = store.getState().currentEntityPage;
    if (current < totalPages - 1) {
      fetchPage(current + 1);
    }
  }, [store, fetchPage, totalPages]);

  const prevPage = useCallback(() => {
    const current = store.getState().currentEntityPage;
    if (current > 0) {
      fetchPage(current - 1);
    }
  }, [store, fetchPage]);

  const fetchEntity = useCallback(
    async (entityId: string): Promise<EntityWithProvenance> => {
      const data = await apiClient.getEntity(jobId, entityId);
      return data as unknown as EntityWithProvenance;
    },
    [apiClient, jobId],
  );

  return {
    pageSize,
    totalPages,
    goToPage,
    nextPage,
    prevPage,
    fetchEntity,
    fetchPage,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useEntityData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/hooks/useEntityData.ts apps/cli/tests/unit/hooks/useEntityData.test.ts
git commit -m "feat(cli): add useEntityData hook for paginated entity fetching"
```

---

### Task 10: DataTable and TableRow components

**Files:**

- Create: `apps/cli/src/components/explorer/TableRow.tsx`
- Create: `apps/cli/src/components/explorer/DataTable.tsx`
- Create: `apps/cli/tests/unit/components/explorer/data-table.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/explorer/data-table.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

describe('DataTable', () => {
  it('module exports DataTable component', async () => {
    const mod = await import('../../../../src/components/explorer/DataTable.js');
    expect(mod.DataTable).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/data-table.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TableRow**

```typescript
// apps/cli/src/components/explorer/TableRow.tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Entity } from '@spatula/shared';

export interface TableRowProps {
  entity: Entity;
  rowNumber: number;
  selected: boolean;
  schemaFields: string[];
  columnOffset: number;
  maxVisibleColumns: number;
  columnWidth: number;
}

function truncate(value: unknown, maxLen: number): string {
  const str = value === null || value === undefined ? '' : String(value);
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}

export function TableRow({
  entity,
  rowNumber,
  selected,
  schemaFields,
  columnOffset,
  maxVisibleColumns,
  columnWidth,
}: TableRowProps) {
  const visibleFields = schemaFields.slice(columnOffset, columnOffset + maxVisibleColumns);
  const prefix = selected ? '>' : ' ';

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>
        {prefix}
        {String(rowNumber).padStart(3)}
        {'  '}
        {(entity.qualityScore ?? 0).toFixed(2).padStart(5)}
        {'  '}
        {String(entity.sourceCount ?? 0).padStart(3)}
        {'  '}
      </Text>
      {visibleFields.map((field) => (
        <Text key={field} color={selected ? 'cyan' : undefined}>
          {truncate(entity.mergedData[field], columnWidth).padEnd(columnWidth + 2)}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Implement DataTable**

```typescript
// apps/cli/src/components/explorer/DataTable.tsx
import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Entity } from '@spatula/shared';
import { TableRow } from './TableRow.js';

export interface DataTableProps {
  entities: Entity[];
  schemaFields: string[];
  selectedIndex: number;
  currentPage: number;
  totalPages: number;
  totalCount: number;
  columnOffset: number;
  pageSize: number;
}

const FIXED_COLS_WIDTH = 18; // "  # | Score | Src | "
const COLUMN_WIDTH = 20;

export function DataTable({
  entities,
  schemaFields,
  selectedIndex,
  currentPage,
  totalPages,
  totalCount,
  columnOffset,
  pageSize,
}: DataTableProps) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 120;

  const maxVisibleColumns = useMemo(() => {
    const available = termWidth - FIXED_COLS_WIDTH;
    return Math.max(1, Math.floor(available / (COLUMN_WIDTH + 2)));
  }, [termWidth]);

  if (entities.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>
          No entities found for this job. Entities are created during the reconciliation phase.
        </Text>
      </Box>
    );
  }

  const visibleFields = schemaFields.slice(columnOffset, columnOffset + maxVisibleColumns);
  const totalSchemaColumns = schemaFields.length;

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        <Text bold dimColor>
          {'   #  Score  Src  '}
        </Text>
        {visibleFields.map((field) => (
          <Text key={field} bold dimColor>
            {field.slice(0, COLUMN_WIDTH).padEnd(COLUMN_WIDTH + 2)}
          </Text>
        ))}
      </Box>

      {/* Data rows */}
      {entities.map((entity, idx) => (
        <TableRow
          key={entity.id}
          entity={entity}
          rowNumber={currentPage * pageSize + idx + 1}
          selected={idx === selectedIndex}
          schemaFields={schemaFields}
          columnOffset={columnOffset}
          maxVisibleColumns={maxVisibleColumns}
          columnWidth={COLUMN_WIDTH}
        />
      ))}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {' '}Page {currentPage + 1} of {totalPages} ({totalCount} entities)
        </Text>
        {totalSchemaColumns > maxVisibleColumns && (
          <Text dimColor>
            {'          '}Showing cols {columnOffset + 1}-{Math.min(columnOffset + maxVisibleColumns, totalSchemaColumns)} of {totalSchemaColumns}
            {columnOffset + maxVisibleColumns < totalSchemaColumns ? ' \u2192' : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/data-table.test.tsx`
Expected: PASS.

- [ ] **Step 6: Add rendering tests**

Add to the test file:

```typescript
it('renders empty state when no entities', () => {
  const { DataTable } = require('../../../../src/components/explorer/DataTable.js');
  const { lastFrame } = render(
    <DataTable
      entities={[]}
      schemaFields={['name', 'price']}
      selectedIndex={0}
      currentPage={0}
      totalPages={1}
      totalCount={0}
      columnOffset={0}
      pageSize={20}
    />,
  );
  expect(lastFrame()).toContain('No entities found');
});

it('renders entity rows with schema columns', () => {
  const { DataTable } = require('../../../../src/components/explorer/DataTable.js');
  const entities = [
    { id: 'e1', mergedData: { name: 'Product A', price: '$10' }, qualityScore: 0.95, sourceCount: 3, categories: [], jobId: 'j1', createdAt: '' },
    { id: 'e2', mergedData: { name: 'Product B', price: '$20' }, qualityScore: 0.8, sourceCount: 1, categories: [], jobId: 'j1', createdAt: '' },
  ];
  const { lastFrame } = render(
    <DataTable
      entities={entities as any}
      schemaFields={['name', 'price']}
      selectedIndex={0}
      currentPage={0}
      totalPages={1}
      totalCount={2}
      columnOffset={0}
      pageSize={20}
    />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain('Product A');
  expect(frame).toContain('Product B');
  expect(frame).toContain('0.95');
  expect(frame).toContain('Page 1 of 1');
});
```

- [ ] **Step 7: Run tests**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/data-table.test.tsx`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/components/explorer/TableRow.tsx apps/cli/src/components/explorer/DataTable.tsx apps/cli/tests/unit/components/explorer/data-table.test.tsx
git commit -m "feat(cli): add DataTable and TableRow components for explorer"
```

---

### Task 11: FilterBar component

**Files:**

- Create: `apps/cli/src/components/explorer/FilterBar.tsx`
- Create: `apps/cli/tests/unit/components/explorer/filter-bar.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/explorer/filter-bar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

describe('FilterBar', () => {
  it('module exports FilterBar component', async () => {
    const mod = await import('../../../../src/components/explorer/FilterBar.js');
    expect(mod.FilterBar).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/filter-bar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement FilterBar**

```typescript
// apps/cli/src/components/explorer/FilterBar.tsx
import React from 'react';
import { Box, Text, useInput } from 'ink';

export interface FilterBarProps {
  filterQuery: string;
  filterMode: 'local' | 'ai';
  matchCount: number;
  totalCount: number;
  focused: boolean;
  onQueryChange: (query: string) => void;
  onToggleMode: () => void;
  onSubmit: () => void;
  onBlur: () => void;
}

export function FilterBar({
  filterQuery,
  filterMode,
  matchCount,
  totalCount,
  focused,
  onQueryChange,
  onToggleMode,
  onBlur,
  onSubmit,
}: FilterBarProps) {
  useInput(
    (input, key) => {
      if (key.escape) {
        // Single Escape: clear filter query AND unfocus (per spec)
        if (filterQuery) {
          onQueryChange('');
        }
        onBlur();
        return;
      }
      if (key.return) {
        onSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        onQueryChange(filterQuery.slice(0, -1));
        return;
      }
      if (input === 'a' || input === 'A') {
        // Check if this is a toggle (ctrl or standalone 'a' when query is empty isn't ideal)
        // Simple approach: toggle mode on 'A' (shift+a), type 'a' on lowercase
        if (input === 'A') {
          onToggleMode();
          return;
        }
      }
      if (input && !key.ctrl && !key.meta) {
        onQueryChange(filterQuery + input);
      }
    },
    { isActive: focused },
  );

  const modeLabel = filterMode === 'ai' ? 'AI' : 'Local';
  const hasFilter = filterQuery.length > 0;

  return (
    <Box>
      <Text dimColor> Filter: </Text>
      <Text color={focused ? 'cyan' : undefined}>
        {filterQuery || (focused ? '' : '(press F to filter)')}
      </Text>
      {focused && <Text color="cyan">_</Text>}
      <Text>{'  '}</Text>
      <Text dimColor>[{modeLabel}]</Text>
      <Text>{'  '}</Text>
      <Text dimColor>
        {hasFilter ? `${matchCount} of ${totalCount} matches` : `${totalCount} entities`}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/filter-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/components/explorer/FilterBar.tsx apps/cli/tests/unit/components/explorer/filter-bar.test.tsx
git commit -m "feat(cli): add FilterBar component for explorer"
```

---

## Chunk 3: Views, Detail & Export

### Task 12: ExplorerView orchestrator + App.tsx integration

**Files:**

- Create: `apps/cli/src/components/explorer/ExplorerView.tsx`
- Create: `apps/cli/src/components/explorer/index.ts`
- Modify: `apps/cli/src/components/App.tsx`
- Create: `apps/cli/tests/unit/components/explorer/explorer-view.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/explorer/explorer-view.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { createCliStore } from '../../../../src/store/index.js';
import type { CliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('../../../../src/hooks/useEntityData.js', () => ({
  useEntityData: vi.fn().mockReturnValue({
    pageSize: 20,
    totalPages: 1,
    goToPage: vi.fn(),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    fetchEntity: vi.fn(),
    fetchPage: vi.fn(),
  }),
}));

vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

function createMockApiClient(): SpatulaApiClient {
  return {
    listEntitiesPaginated: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getEntity: vi.fn().mockResolvedValue({}),
    getSchema: vi.fn().mockResolvedValue({ fields: [] }),
  } as unknown as SpatulaApiClient;
}

describe('ExplorerView', () => {
  let store: CliStore;
  let apiClient: SpatulaApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createCliStore('test-tenant');
    apiClient = createMockApiClient();
    store.getState().setActiveJobId('job-1');
  });

  it('renders empty state when no entities', async () => {
    const { ExplorerView } = await import('../../../../src/components/explorer/ExplorerView.js');
    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()).toContain('No entities found');
  });

  it('renders data table when entities are present', async () => {
    store.getState().setEntities([
      { id: 'e1', jobId: 'j1', mergedData: { name: 'Test' }, categories: [], qualityScore: 0.9, createdAt: '', sourceCount: 2 },
    ] as any);
    store.getState().setTotalEntityCount(1);
    store.getState().setSchemaData({ version: 1, fields: [{ name: 'name', type: 'string' }] });

    const { ExplorerView } = await import('../../../../src/components/explorer/ExplorerView.js');
    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()).toContain('Test');
  });

  it('shows no-active-job message when activeJobId is null', async () => {
    store.getState().setActiveJobId(null);

    const { ExplorerView } = await import('../../../../src/components/explorer/ExplorerView.js');
    const { lastFrame } = render(
      <ExplorerView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()).toContain('No active job');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/explorer-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create stub files for EntityDetail and ExportDialog (implemented fully in Tasks 13, 15)**

```typescript
// apps/cli/src/components/explorer/EntityDetail.tsx
import React from 'react';
import { Text } from 'ink';
import type { EntityWithProvenance } from '@spatula/shared';

export interface EntityDetailProps { entity: EntityWithProvenance; }
export function EntityDetail({ entity }: EntityDetailProps) {
  return <Text>Entity: {entity.id}</Text>;
}

// apps/cli/src/components/explorer/ExportDialog.tsx
import React from 'react';
import { Text } from 'ink';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';

export interface ExportDialogProps { store: CliStore; apiClient: SpatulaApiClient; fromDetail: boolean; onClose: () => void; }
export function ExportDialog({ onClose }: ExportDialogProps) {
  return <Text>Export dialog (stub)</Text>;
}
```

- [ ] **Step 4: Implement ExplorerView**

```typescript
// apps/cli/src/components/explorer/ExplorerView.tsx
import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { useEntityData } from '../../hooks/useEntityData.js';
import { useEntityFilter } from '../../hooks/useEntityFilter.js';
import { DataTable } from './DataTable.js';
import { FilterBar } from './FilterBar.js';
import { EntityDetail } from './EntityDetail.js';
import { ExportDialog } from './ExportDialog.js';
import { KeyboardHints, Spinner } from '../shared/index.js';
// Note: App.tsx already renders <Header mode={mode} />, so ExplorerView does NOT render its own Header.
import type { KeyHint } from '../shared/index.js';
import type { EntityWithProvenance } from '@spatula/shared';

type ExplorerSubView = 'table' | 'detail' | 'export';

export interface ExplorerViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

export function ExplorerView({ store, apiClient }: ExplorerViewProps) {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const entities = useStore(store, (s) => s.entities);
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const currentEntityPage = useStore(store, (s) => s.currentEntityPage);
  const selectedEntityIndex = useStore(store, (s) => s.selectedEntityIndex);
  const expandedEntity = useStore(store, (s) => s.expandedEntity);
  const filterQuery = useStore(store, (s) => s.filterQuery);
  const filterMode = useStore(store, (s) => s.filterMode);
  const filterFocused = useStore(store, (s) => s.filterFocused);
  const schemaData = useStore(store, (s) => s.schemaData);

  const [subView, setSubView] = useState<ExplorerSubView>('table');
  const [columnOffset, setColumnOffset] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const { pageSize, totalPages, nextPage, prevPage, fetchEntity, fetchPage } = useEntityData(
    store,
    apiClient,
    activeJobId ?? '',
  );

  const { setFilterQuery: applyFilter, clearFilter } = useEntityFilter(
    store,
    apiClient,
    activeJobId ?? '',
    totalEntityCount,
  );

  // Extract schema field names for table columns
  const schemaFields = useMemo(() => {
    if (!schemaData) return [];
    const definition = (schemaData as any).definition ?? schemaData;
    const fields = (definition as any)?.fields ?? [];
    return fields.map((f: any) => f.name as string);
  }, [schemaData]);

  // Open entity detail
  const openDetail = useCallback(async () => {
    const entity = entities[selectedEntityIndex];
    if (!entity) return;
    setDetailLoading(true);
    setDetailError(null);
    setSubView('detail');
    try {
      const full = await fetchEntity(entity.id);
      store.getState().setExpandedEntity(full);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, [entities, selectedEntityIndex, fetchEntity, store]);

  // Table keyboard handlers (active when not filtering and in table view)
  useKeyboard(
    subView === 'table'
      ? {
          upArrow: () => {
            const idx = store.getState().selectedEntityIndex;
            if (idx > 0) store.getState().setSelectedEntityIndex(idx - 1);
          },
          downArrow: () => {
            const idx = store.getState().selectedEntityIndex;
            if (idx < entities.length - 1) store.getState().setSelectedEntityIndex(idx + 1);
          },
          leftArrow: () => setColumnOffset((o) => Math.max(0, o - 1)),
          rightArrow: () =>
            setColumnOffset((o) => Math.min(o + 1, Math.max(0, schemaFields.length - 1))),
          return: () => openDetail(),
          f: () => store.getState().setFilterFocused(true),
          F: () => store.getState().setFilterFocused(true),
          e: () => setSubView('export'),
          E: () => setSubView('export'),
          n: () => nextPage(),
          N: () => nextPage(),
          p: () => prevPage(),
          P: () => prevPage(),
          ']': () => nextPage(),
          '[': () => prevPage(),
        }
      : {},
    subView === 'table' && !filterFocused,
  );

  // Detail view keyboard handlers
  useKeyboard(
    subView === 'detail'
      ? {
          escape: () => {
            store.getState().setExpandedEntity(null);
            setSubView('table');
          },
          e: () => setSubView('export'),
          E: () => setSubView('export'),
        }
      : {},
    subView === 'detail',
  );

  // Build hints based on sub-view
  const hints: KeyHint[] = useMemo(() => {
    if (subView === 'detail') {
      return [
        { key: '\u2191\u2193', description: 'scroll' },
        { key: 'E', description: 'export' },
        { key: 'Esc', description: 'back' },
      ];
    }
    if (filterFocused) {
      return [
        { key: 'A', description: 'toggle AI' },
        { key: 'Esc', description: 'unfocus' },
      ];
    }
    return [
      { key: '\u2191\u2193', description: 'select' },
      { key: '\u2190\u2192', description: 'scroll cols' },
      { key: 'N/P', description: 'page' },
      { key: 'Enter', description: 'detail' },
      { key: 'F', description: 'filter' },
      { key: 'E', description: 'export' },
    ];
  }, [subView, filterFocused]);

  if (!activeJobId) {
    return (
      <Box flexDirection="column">
        {/* Header rendered by App.tsx */}
        <Box paddingX={1}>
          <Text dimColor>No active job. Start a job first.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header rendered by App.tsx */}

      {subView === 'detail' ? (
        detailLoading ? (
          <Spinner label="Loading entity..." />
        ) : detailError ? (
          <Box paddingX={1} flexDirection="column">
            <Text color="red">Error: {detailError}</Text>
            <Text dimColor>Press Escape to return to table.</Text>
          </Box>
        ) : expandedEntity ? (
          <EntityDetail entity={expandedEntity} />
        ) : null
      ) : (
        <>
          <FilterBar
            filterQuery={filterQuery}
            filterMode={filterMode}
            matchCount={entities.length}
            totalCount={totalEntityCount}
            focused={filterFocused}
            onQueryChange={(q) => applyFilter(q)}
            onToggleMode={() =>
              store.getState().setFilterMode(filterMode === 'local' ? 'ai' : 'local')
            }
            onSubmit={() => {
              /* AI filter submit — stretch goal */
            }}
            onBlur={() => {
              store.getState().setFilterFocused(false);
              if (filterQuery) {
                clearFilter();
                fetchPage(0); // re-fetch unfiltered data
              }
            }}
          />
          <DataTable
            entities={entities as any}
            schemaFields={schemaFields}
            selectedIndex={selectedEntityIndex}
            currentPage={currentEntityPage}
            totalPages={totalPages}
            totalCount={totalEntityCount}
            columnOffset={columnOffset}
            pageSize={pageSize}
          />
        </>
      )}

      {subView === 'export' && (
        <ExportDialog
          store={store}
          apiClient={apiClient}
          fromDetail={expandedEntity !== null}
          onClose={() => setSubView(expandedEntity ? 'detail' : 'table')}
        />
      )}

      <KeyboardHints hints={hints} />
    </Box>
  );
}
```

- [ ] **Step 4: Create index.ts barrel export**

```typescript
// apps/cli/src/components/explorer/index.ts
export { ExplorerView } from './ExplorerView.js';
export { DataTable } from './DataTable.js';
export { TableRow } from './TableRow.js';
export { FilterBar } from './FilterBar.js';
```

Note: EntityDetail and ExportDialog will be added in Tasks 12-14.

- [ ] **Step 5: Update App.tsx to route explorer mode and suppress keys when filter focused**

In `apps/cli/src/components/App.tsx`:

1. Add import:

```typescript
import { ExplorerView } from './explorer/index.js';
```

2. Replace the explorer placeholder (around line 116) with:

```typescript
{mode === 'explorer' && <ExplorerView store={store} apiClient={apiClient} />}
```

3. Read `filterFocused` from store (add near line 56):

```typescript
const filterFocused = useStore(store, (s) => s.filterFocused);
```

4. Pass `isActive` to the `useKeyboard` call (line 100):

```typescript
useKeyboard(modeKeys[mode] ?? {}, !filterFocused);
```

5. Update `hintsForMode` to return empty array for explorer (ExplorerView manages its own hints):

```typescript
if (mode === 'explorer') return [];
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/explorer-view.test.tsx`
Expected: PASS (stubs already created in Step 3).

- [ ] **Step 8: Run full CLI test suite**

Run: `cd apps/cli && pnpm test`
Expected: All PASS (including existing App.tsx tests).

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/components/explorer/ apps/cli/src/components/App.tsx apps/cli/tests/unit/components/explorer/
git commit -m "feat(cli): add ExplorerView orchestrator and App.tsx integration"
```

---

### Task 13: EntityDetail component

**Files:**

- Modify: `apps/cli/src/components/explorer/EntityDetail.tsx` (replace stub)
- Create: `apps/cli/tests/unit/components/explorer/entity-detail.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/explorer/entity-detail.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { EntityDetail } from '../../../../src/components/explorer/EntityDetail.js';
import type { EntityWithProvenance } from '@spatula/shared';

const mockEntity: EntityWithProvenance = {
  id: 'ent-1',
  jobId: 'job-1',
  mergedData: { name: 'Bose QC Ultra', price: '$429.00' },
  provenance: {
    name: {
      finalValue: 'Bose QC Ultra',
      provenanceType: 'merged',
      sources: [
        { sourceUrl: 'https://amazon.com', rawValue: 'Bose QuietComfort Ultra', normalizedValue: 'Bose QC Ultra' },
        { sourceUrl: 'https://bestbuy.com', rawValue: 'BOSE QC Ultra Headphones', normalizedValue: 'Bose QC Ultra' },
      ],
      hadConflict: false,
      resolution: 'most_complete',
    },
    price: {
      finalValue: '$429.00',
      provenanceType: 'normalized',
      sources: [
        { sourceUrl: 'https://amazon.com', rawValue: '$429.00', normalizedValue: '$429.00' },
      ],
      hadConflict: false,
    },
  },
  categories: ['headphones', 'audio'],
  qualityScore: 0.85,
  createdAt: '2026-03-10',
  sourceCount: 4,
  sources: [
    { extractionId: 'ext-1', matchConfidence: 0.9, sourceUrl: 'https://amazon.com' },
    { extractionId: 'ext-2', matchConfidence: 0.85, sourceUrl: 'https://bestbuy.com' },
  ],
};

describe('EntityDetail', () => {
  it('renders entity quality score', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('0.85');
  });

  it('renders entity categories', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('headphones');
    expect(lastFrame()).toContain('audio');
  });

  it('renders field names and values', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('name');
    expect(lastFrame()).toContain('Bose QC Ultra');
    expect(lastFrame()).toContain('price');
    expect(lastFrame()).toContain('$429.00');
  });

  it('renders provenance type for each field', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('merged');
    expect(lastFrame()).toContain('normalized');
  });

  it('renders source URLs', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('amazon.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/entity-detail.test.tsx`
Expected: FAIL — stub EntityDetail doesn't render provenance.

- [ ] **Step 3: Implement full EntityDetail**

Replace `apps/cli/src/components/explorer/EntityDetail.tsx`:

```typescript
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { EntityWithProvenance } from '@spatula/shared';
import type { FieldProvenanceEntry } from '@spatula/core';
import { Panel } from '../shared/index.js';

export interface EntityDetailProps {
  entity: EntityWithProvenance;
}

export function EntityDetail({ entity }: EntityDetailProps) {
  const provenance = entity.provenance;
  const fields = Object.keys(entity.mergedData);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title="Entity Detail">
        <Box>
          <Text bold>Quality: </Text>
          <Text>{entity.qualityScore.toFixed(2)}</Text>
          <Text>{'    '}</Text>
          <Text bold>Sources: </Text>
          <Text>{entity.sourceCount}</Text>
          <Text>{'    '}</Text>
          <Text bold>Categories: </Text>
          <Text>{entity.categories.join(', ') || 'none'}</Text>
        </Box>
      </Panel>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {fields.map((field) => {
          const value = entity.mergedData[field];
          const prov = provenance[field];
          const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');

          return (
            <Box key={field} flexDirection="column" marginBottom={1}>
              <Text bold color="cyan">
                {field}: <Text color="white">{displayValue}</Text>
              </Text>

              {prov && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text dimColor>
                    \u251c\u2500 provenance: {prov.provenanceType}
                    {prov.sources ? ` (${prov.sources.length} source${prov.sources.length !== 1 ? 's' : ''})` : ''}
                  </Text>

                  {prov.sources && prov.sources.length > 0 && (
                    <>
                      <Text dimColor>\u251c\u2500 sources:</Text>
                      {prov.sources.map((src, i) => {
                        const domain = (() => {
                          try { return new URL(src.sourceUrl).hostname; } catch { return src.sourceUrl; }
                        })();
                        const isLast = i === prov.sources!.length - 1;
                        const prefix = isLast ? '\u2502   \u2514\u2500' : '\u2502   \u251c\u2500';
                        return (
                          <Text key={i} dimColor>
                            {prefix} {domain} \u2192 {JSON.stringify(src.rawValue)}
                            {prov.hadConflict && src.rawValue !== prov.finalValue ? (
                              <Text color="yellow"> (conflict)</Text>
                            ) : null}
                          </Text>
                        );
                      })}
                    </>
                  )}

                  {prov.resolution && (
                    <Text dimColor>\u2514\u2500 resolution: {prov.resolution}</Text>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/entity-detail.test.tsx`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/components/explorer/EntityDetail.tsx apps/cli/tests/unit/components/explorer/entity-detail.test.tsx
git commit -m "feat(cli): implement EntityDetail with provenance tree display"
```

---

### Task 14: useExport hook

**Files:**

- Create: `apps/cli/src/hooks/useExport.ts`
- Create: `apps/cli/tests/unit/hooks/useExport.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/hooks/useExport.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('useExport', () => {
  it('module exports useExport function', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    expect(typeof mod.useExport).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement useExport**

```typescript
// apps/cli/src/hooks/useExport.ts
import { useState, useCallback } from 'react';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpatulaApiClient } from '../api/client.js';
import type { Entity, EntityWithProvenance } from '@spatula/shared';

function entityToCsvRow(entity: Entity, fields: string[]): string {
  return fields
    .map((field) => {
      const val = entity.mergedData[field];
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      // RFC 4180: quote if contains comma, quote, or newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(',');
}

function entitiesToCsv(entities: Entity[], fields: string[]): string {
  const header = fields.join(',');
  const rows = entities.map((e) => entityToCsvRow(e, fields));
  return [header, ...rows].join('\n');
}

function entitiesToJson(
  entities: Entity[],
  options: { jobId: string; filterQuery?: string },
): string {
  return JSON.stringify(
    {
      metadata: {
        jobId: options.jobId,
        exportedAt: new Date().toISOString(),
        count: entities.length,
        ...(options.filterQuery ? { filterQuery: options.filterQuery } : {}),
      },
      entities: entities.map((e) => ({
        data: e.mergedData,
        provenance: (e as EntityWithProvenance).provenance ?? null,
        qualityScore: e.qualityScore,
        categories: e.categories,
        sourceCount: e.sourceCount,
      })),
    },
    null,
    2,
  );
}

function generateFilename(jobId: string, format: 'json' | 'csv'): string {
  const short = jobId.slice(0, 8);
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `spatula-${short}-${ts}.${format}`;
}

export function useExport(apiClient: SpatulaApiClient) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ fetched: number; total: number } | null>(
    null,
  );

  const exportSingleEntity = useCallback(
    async (
      entity: EntityWithProvenance,
      format: 'json' | 'csv',
      options: { jobId: string },
    ): Promise<string> => {
      const filename = generateFilename(options.jobId, format);
      const filepath = join(process.cwd(), filename);

      const fields = Object.keys(entity.mergedData);
      const content =
        format === 'csv' ? entitiesToCsv([entity], fields) : entitiesToJson([entity], options);

      await writeFile(filepath, content, 'utf-8');
      return filepath;
    },
    [],
  );

  const exportEntitySet = useCallback(
    async (
      jobId: string,
      format: 'json' | 'csv',
      options: { search?: string; filterQuery?: string; schemaFields: string[] },
    ): Promise<string> => {
      setIsExporting(true);
      setExportProgress({ fetched: 0, total: 0 });

      try {
        // First fetch to get total
        const first = await apiClient.listEntitiesPaginated(jobId, {
          limit: 100,
          offset: 0,
          ...(options.search ? { search: options.search } : {}),
        });

        const allEntities: Entity[] = [...(first.data as unknown as Entity[])];
        const total = first.total;
        setExportProgress({ fetched: allEntities.length, total });

        // Fetch remaining pages
        let offset = 100;
        while (offset < total) {
          const page = await apiClient.listEntitiesPaginated(jobId, {
            limit: 100,
            offset,
            ...(options.search ? { search: options.search } : {}),
          });
          allEntities.push(...(page.data as unknown as Entity[]));
          offset += 100;
          setExportProgress({ fetched: allEntities.length, total });
        }

        const filename = generateFilename(jobId, format);
        const filepath = join(process.cwd(), filename);

        const content =
          format === 'csv'
            ? entitiesToCsv(allEntities, options.schemaFields)
            : entitiesToJson(allEntities, { jobId, filterQuery: options.filterQuery });

        await writeFile(filepath, content, 'utf-8');
        return filepath;
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [apiClient],
  );

  return { isExporting, exportProgress, exportSingleEntity, exportEntitySet };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Add export logic tests**

Add to the test file — test the CSV/JSON serialization helpers by extracting them or testing through the hook:

```typescript
// Test CSV escaping and JSON format by calling the exported functions
// if they are exported, or by testing through the hook with mock data.
// The key tests are: RFC 4180 CSV escaping, JSON metadata, filename format.
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/hooks/useExport.ts apps/cli/tests/unit/hooks/useExport.test.ts
git commit -m "feat(cli): add useExport hook for JSON/CSV entity export"
```

---

### Task 15: ExportDialog component

**Files:**

- Modify: `apps/cli/src/components/explorer/ExportDialog.tsx` (replace stub)
- Create: `apps/cli/tests/unit/components/explorer/export-dialog.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/explorer/export-dialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { createCliStore } from '../../../../src/store/index.js';
import type { CliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('../../../../src/hooks/useExport.js', () => ({
  useExport: vi.fn().mockReturnValue({
    isExporting: false,
    exportProgress: null,
    exportSingleEntity: vi.fn().mockResolvedValue('/path/to/file.json'),
    exportEntitySet: vi.fn().mockResolvedValue('/path/to/file.json'),
  }),
}));

describe('ExportDialog', () => {
  it('renders export format options', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = {} as SpatulaApiClient;

    const { ExportDialog } = await import('../../../../src/components/explorer/ExportDialog.js');
    const { lastFrame } = render(
      <ExportDialog store={store} apiClient={apiClient} fromDetail={false} onClose={vi.fn()} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('JSON');
    expect(frame).toContain('CSV');
  });

  it('renders scope options', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setTotalEntityCount(47);
    const apiClient = {} as SpatulaApiClient;

    const { ExportDialog } = await import('../../../../src/components/explorer/ExportDialog.js');
    const { lastFrame } = render(
      <ExportDialog store={store} apiClient={apiClient} fromDetail={false} onClose={vi.fn()} />,
    );
    expect(lastFrame()).toContain('47');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/export-dialog.test.tsx`
Expected: FAIL — stub doesn't render format options.

- [ ] **Step 3: Implement ExportDialog**

Replace `apps/cli/src/components/explorer/ExportDialog.tsx`:

```typescript
import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { useExport } from '../../hooks/useExport.js';
import { Panel } from '../shared/index.js';
import type { EntityWithProvenance } from '@spatula/shared';

export interface ExportDialogProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
  fromDetail: boolean;
  onClose: () => void;
}

type ExportFormat = 'json' | 'csv';
type ExportScope = 'entity' | 'set';

export function ExportDialog({ store, apiClient, fromDetail, onClose }: ExportDialogProps) {
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const filterQuery = useStore(store, (s) => s.filterQuery);
  const expandedEntity = useStore(store, (s) => s.expandedEntity);
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const schemaData = useStore(store, (s) => s.schemaData);

  const [format, setFormat] = useState<ExportFormat>('json');
  const [scope, setScope] = useState<ExportScope>(fromDetail ? 'entity' : 'set');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { isExporting, exportProgress, exportSingleEntity, exportEntitySet } = useExport(apiClient);

  const schemaFields = (() => {
    if (!schemaData) return [];
    const definition = (schemaData as any).definition ?? schemaData;
    const fields = (definition as any)?.fields ?? [];
    return fields.map((f: any) => f.name as string);
  })();

  const doExport = useCallback(async () => {
    if (!activeJobId) return;

    try {
      let filepath: string;
      if (scope === 'entity' && expandedEntity) {
        filepath = await exportSingleEntity(expandedEntity as EntityWithProvenance, format, {
          jobId: activeJobId,
        });
      } else {
        filepath = await exportEntitySet(activeJobId, format, {
          search: filterQuery || undefined,
          filterQuery: filterQuery || undefined,
          schemaFields,
        });
      }
      setResult(filepath);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeJobId, scope, expandedEntity, format, filterQuery, schemaFields, exportSingleEntity, exportEntitySet]);

  useKeyboard(
    {
      leftArrow: () => setFormat((f) => (f === 'json' ? 'csv' : 'json')),
      rightArrow: () => setFormat((f) => (f === 'json' ? 'csv' : 'json')),
      upArrow: () => fromDetail && setScope((s) => (s === 'entity' ? 'set' : 'entity')),
      downArrow: () => fromDetail && setScope((s) => (s === 'entity' ? 'set' : 'entity')),
      return: () => doExport(),
      escape: () => onClose(),
    },
    !isExporting,
  );

  const setLabel = filterQuery
    ? `Filtered results (${totalEntityCount})`
    : `All results (${totalEntityCount})`;

  if (result) {
    return (
      <Panel title="Export">
        <Text color="green">Exported to {result}</Text>
        <Text dimColor> Press Escape to close.</Text>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel title="Export">
        <Text color="red">Export failed: {error}</Text>
        <Text dimColor> Press Escape to close.</Text>
      </Panel>
    );
  }

  if (isExporting && exportProgress) {
    return (
      <Panel title="Export">
        <Text>Fetching entities for export... ({exportProgress.fetched}/{exportProgress.total})</Text>
      </Panel>
    );
  }

  return (
    <Panel title="Export">
      <Box flexDirection="column">
        <Box>
          <Text bold>Format:   </Text>
          <Text color={format === 'json' ? 'cyan' : undefined} bold={format === 'json'}>
            {format === 'json' ? '[JSON]' : ' JSON '}
          </Text>
          <Text>{'  '}</Text>
          <Text color={format === 'csv' ? 'cyan' : undefined} bold={format === 'csv'}>
            {format === 'csv' ? '[CSV]' : ' CSV '}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Scope:    </Text>
          {fromDetail && (
            <Text color={scope === 'entity' ? 'cyan' : undefined} bold={scope === 'entity'}>
              {scope === 'entity' ? '[Current entity]' : ' Current entity '}
            </Text>
          )}
          <Text color={scope === 'set' ? 'cyan' : undefined} bold={scope === 'set'}>
            {scope === 'set' ? `[${setLabel}]` : ` ${setLabel} `}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Enter to export \u00b7 Escape to cancel</Text>
        </Box>
      </Box>
    </Panel>
  );
}
```

- [ ] **Step 4: Update explorer/index.ts**

Add to `apps/cli/src/components/explorer/index.ts`:

```typescript
export { EntityDetail } from './EntityDetail.js';
export { ExportDialog } from './ExportDialog.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/components/explorer/export-dialog.test.tsx`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/components/explorer/ExportDialog.tsx apps/cli/src/components/explorer/index.ts apps/cli/tests/unit/components/explorer/export-dialog.test.tsx
git commit -m "feat(cli): implement ExportDialog with JSON/CSV format selection"
```

---

### Task 16: useEntityFilter hook (local filtering)

**Files:**

- Create: `apps/cli/src/hooks/useEntityFilter.ts`
- Create: `apps/cli/tests/unit/hooks/useEntityFilter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/hooks/useEntityFilter.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('useEntityFilter', () => {
  it('module exports useEntityFilter function', async () => {
    const mod = await import('../../../src/hooks/useEntityFilter.js');
    expect(typeof mod.useEntityFilter).toBe('function');
  });

  it('exports filterEntitiesLocally for testing', async () => {
    const mod = await import('../../../src/hooks/useEntityFilter.js');
    expect(typeof mod.filterEntitiesLocally).toBe('function');
  });
});

describe('filterEntitiesLocally', () => {
  it('filters entities by text match across all field values', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'Bluetooth Speaker', price: '$49' } },
      { id: 'e2', mergedData: { name: 'Wired Headphones', price: '$25' } },
      { id: 'e3', mergedData: { name: 'Bluetooth Earbuds', price: '$79' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'bluetooth');
    expect(result).toHaveLength(2);
    expect(result.map((e: any) => e.id)).toEqual(['e1', 'e3']);
  });

  it('is case-insensitive', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [{ id: 'e1', mergedData: { name: 'SONY Headphones' } }];
    const result = filterEntitiesLocally(entities as any, 'sony');
    expect(result).toHaveLength(1);
  });

  it('returns all entities for empty query', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'A' } },
      { id: 'e2', mergedData: { name: 'B' } },
    ];
    const result = filterEntitiesLocally(entities as any, '');
    expect(result).toHaveLength(2);
  });

  it('matches across multiple fields', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'Speaker', brand: 'JBL' } },
      { id: 'e2', mergedData: { name: 'JBL Flip', brand: 'JBL' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'jbl');
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useEntityFilter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement useEntityFilter**

```typescript
// apps/cli/src/hooks/useEntityFilter.ts
import { useEffect, useMemo, useCallback, useRef } from 'react';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { Entity } from '@spatula/shared';

/**
 * Case-insensitive text filter across all mergedData field values.
 * Exported for direct testing.
 */
export function filterEntitiesLocally(entities: Entity[], query: string): Entity[] {
  if (!query) return entities;
  const lower = query.toLowerCase();
  return entities.filter((entity) => {
    const values = Object.values(entity.mergedData);
    return values.some((v) => {
      if (v === null || v === undefined) return false;
      return String(v).toLowerCase().includes(lower);
    });
  });
}

export function useEntityFilter(
  store: CliStore,
  apiClient: SpatulaApiClient,
  jobId: string,
  totalCount: number,
) {
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a snapshot of unfiltered entities for local filtering
  const unfilteredEntities = useRef<Entity[]>([]);

  const applyLocalFilter = useCallback(
    (query: string) => {
      const state = store.getState();
      // On first filter, snapshot current entities
      if (unfilteredEntities.current.length === 0) {
        unfilteredEntities.current = [...state.entities];
      }
      if (!query) {
        // Restore original entities
        state.setEntities(unfilteredEntities.current);
        return;
      }
      const filtered = filterEntitiesLocally(unfilteredEntities.current, query);
      state.setEntities(filtered);
    },
    [store],
  );

  const applyServerFilter = useCallback(
    async (query: string, page = 0, pageSize = 50) => {
      try {
        const result = await apiClient.listEntitiesPaginated(jobId, {
          limit: pageSize,
          offset: page * pageSize,
          search: query,
        });
        const state = store.getState();
        state.setEntities(result.data as unknown as Entity[]);
        state.setTotalEntityCount(result.total);
        state.setCurrentEntityPage(page);
        state.setSelectedEntityIndex(0);
      } catch (error) {
        store.getState().setError(`Filter failed: ${(error as Error).message}`);
      }
    },
    [store, apiClient, jobId],
  );

  // Debounced filter application
  const setFilterQuery = useCallback(
    (query: string) => {
      store.getState().setFilterQuery(query);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        if (totalCount < 500) {
          applyLocalFilter(query);
        } else {
          applyServerFilter(query);
        }
      }, 200);
    },
    [store, totalCount, applyLocalFilter, applyServerFilter],
  );

  const clearFilter = useCallback(() => {
    store.getState().setFilterQuery('');
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    // Restore unfiltered snapshot for local filter; for server filter, caller re-fetches
    if (unfilteredEntities.current.length > 0) {
      store.getState().setEntities(unfilteredEntities.current);
      unfilteredEntities.current = [];
    }
  }, [store]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return {
    setFilterQuery,
    clearFilter,
    applyServerFilter,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm test -- --run tests/unit/hooks/useEntityFilter.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/hooks/useEntityFilter.ts apps/cli/tests/unit/hooks/useEntityFilter.test.ts
git commit -m "feat(cli): add useEntityFilter hook with local text filtering"
```

---

### Task 17: Final integration and full test run

**Files:**

- No new files — verify everything works together

- [ ] **Step 1: Run full DB package tests**

Run: `cd packages/db && pnpm test`
Expected: All PASS.

- [ ] **Step 2: Run full API tests**

Run: `cd apps/api && pnpm test`
Expected: All PASS.

- [ ] **Step 3: Run full CLI tests**

Run: `cd apps/cli && pnpm test`
Expected: All PASS.

- [ ] **Step 4: Run full monorepo build**

Run: `pnpm build`
Expected: Clean build across all packages.

- [ ] **Step 5: Run full monorepo tests**

Run: `pnpm test`
Expected: All PASS across all packages.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(cli): resolve integration issues from Phase 9c"
```
