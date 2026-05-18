# Wave 3-3b: Performance — Query & Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add database indexes for common query patterns, cursor-based pagination across all list endpoints, incremental fetch via `?since=` parameter, and a Redis read-through cache for hot paths.

**Architecture:** New indexes on 4 tables improve query performance for tenant-scoped lookups. A shared cursor encoding utility produces opaque base64 cursors containing `{id, sortValue}`, used by `findByCursor()` repository methods on all 4 list endpoints. An `updated_at` column is added to 4 tables to support incremental fetch (`?since=`). A `RedisCache` class provides `getOrFetch<T>()` read-through caching with TTL and pattern-based invalidation via `SCAN`+`DEL`, wired to 4 hot paths (schema, job config, tenant quotas, entity count).

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), ioredis, Hono, `@hono/zod-openapi`, Vitest

**Spec references:**

- Phase 12 spec: sections 6.3-6.5
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.5

**Depends on:** Wave 3-1b (`AppDeps.redis`), Wave 3-3a (`EntityRepository.findByJobCursor`)

---

## File Structure

### New Files

| File                                        | Responsibility                                               |
| ------------------------------------------- | ------------------------------------------------------------ |
| `packages/shared/src/cursor.ts`             | `encodeCursor()` / `decodeCursor()` base64 helpers           |
| `packages/db/src/cache.ts`                  | `RedisCache` class with `getOrFetch<T>()` and `invalidate()` |
| `packages/shared/tests/unit/cursor.test.ts` | Cursor encoding tests                                        |
| `packages/db/tests/unit/cache.test.ts`      | RedisCache tests                                             |

### Modified Files

| File                                                    | Change                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `packages/db/src/schema/entities.ts`                    | Add `updatedAt` column, extend `entities_job_quality_idx` |
| `packages/db/src/schema/extractions.ts`                 | Add `updatedAt` column, add new indexes                   |
| `packages/db/src/schema/actions.ts`                     | Add `updatedAt` column                                    |
| `packages/db/src/schema/exports.ts`                     | Add `updatedAt` column, add new indexes                   |
| `packages/db/src/schema/content.ts`                     | Add `idx_content_store_key` index                         |
| `packages/db/src/repositories/entity-repository.ts`     | Add `updated_at` writes, cursor with `since` filter       |
| `packages/db/src/repositories/extraction-repository.ts` | Add `findByCursor()`, `updated_at` writes                 |
| `packages/db/src/repositories/action-repository.ts`     | Add `findByCursor()`, `updated_at` writes                 |
| `packages/db/src/repositories/export-repository.ts`     | Add `findByCursor()`, `updated_at` writes                 |
| `packages/db/src/repositories/schema-repository.ts`     | Cache invalidation on write                               |
| `packages/db/src/repositories/tenant-repository.ts`     | Cache invalidation on update                              |
| `packages/db/src/index.ts`                              | Export `RedisCache`                                       |
| `packages/shared/src/index.ts`                          | Export cursor utils                                       |
| `apps/api/src/schemas/pagination.ts`                    | Add `cursor` and `since` params                           |
| `apps/api/src/routes/entities.ts`                       | Cursor pagination + `since`                               |
| `apps/api/src/routes/extractions.ts`                    | Cursor pagination + `since`                               |
| `apps/api/src/routes/actions.ts`                        | Cursor pagination + `since`                               |
| `apps/api/src/routes/exports.ts`                        | Cursor pagination + `since`                               |
| `apps/api/src/types.ts`                                 | Add `cache` to `AppDeps`                                  |

---

## Task 1: Database Indexes + updated_at Migration

**Files:**

- Modify: `packages/db/src/schema/entities.ts`
- Modify: `packages/db/src/schema/extractions.ts`
- Modify: `packages/db/src/schema/actions.ts`
- Modify: `packages/db/src/schema/exports.ts`
- Modify: `packages/db/src/schema/content.ts`

- [ ] **Step 1: Add updated_at to entities schema and extend quality index**

Read `packages/db/src/schema/entities.ts`. Add the `updatedAt` column and new indexes:

```typescript
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
```

Add to the indexes array:

```typescript
    index('idx_entities_job_tenant').on(table.jobId, table.tenantId),
    index('idx_entities_updated').on(table.updatedAt),
```

Also extend the existing quality index for keyset pagination. Replace:

```typescript
    index('entities_job_quality_idx').on(table.jobId, table.qualityScore),
```

with:

```typescript
    index('entities_job_quality_idx').on(table.jobId, table.qualityScore, table.id),
    // Note: Drizzle's .on() generates ASC-only indexes. The spec wants (job_id, quality_score DESC, id ASC).
    // Postgres B-tree indexes are traversable in both directions, so ASC index works for DESC queries
    // with slightly less efficiency. If the generated migration doesn't include DESC, this is acceptable.
    // Verify the migration output and add a raw SQL index in a separate migration if needed.
```

- [ ] **Step 2: Add updated_at to extractions schema and new indexes**

Read `packages/db/src/schema/extractions.ts`. Add:

```typescript
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
```

Add to indexes:

```typescript
    index('idx_extractions_job').on(table.jobId, table.tenantId),
    index('idx_extractions_updated').on(table.updatedAt),
```

Note: `extractions_page_idx` already exists on `pageId` — no need to add `idx_extractions_page`.

- [ ] **Step 3: Add updated_at to actions schema**

Read `packages/db/src/schema/actions.ts`. Add:

```typescript
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
```

Add index:

```typescript
    index('idx_actions_updated').on(table.updatedAt),
```

- [ ] **Step 4: Add updated_at to exports schema and new index**

Read `packages/db/src/schema/exports.ts`. Add:

```typescript
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
```

Add to indexes:

```typescript
    index('idx_exports_job_tenant').on(table.jobId, table.tenantId),
    index('idx_exports_updated').on(table.updatedAt),
```

- [ ] **Step 5: Add index to content_store**

Read `packages/db/src/schema/content.ts`. The `key` column already has `.unique()` which creates an implicit unique index. Verify this — if so, `idx_content_store_key` is unnecessary. If the unique constraint doesn't create a usable index, add one explicitly.

- [ ] **Step 6: Generate migration**

```bash
pnpm --filter @spatula/db db:generate
```

Verify the generated migration adds `updated_at` columns and new indexes.

- [ ] **Step 7: Build and test**

```bash
pnpm --filter @spatula/db build && pnpm --filter @spatula/db test
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/ packages/db/drizzle/
git commit -m "feat(db): add updated_at columns, performance indexes, and quality index extension"
```

---

## Task 2: Cursor Encoding/Decoding Utility

**Files:**

- Create: `packages/shared/src/cursor.ts`
- Create: `packages/shared/tests/unit/cursor.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/tests/unit/cursor.test.ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/cursor.js';

describe('cursor encoding', () => {
  it('encodes and decodes a cursor with id and sortValue', () => {
    const cursor = encodeCursor({ id: 'abc-123', sortValue: '2026-03-28' });
    expect(typeof cursor).toBe('string');

    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('abc-123');
    expect(decoded.sortValue).toBe('2026-03-28');
  });

  it('encodes and decodes a cursor with numeric sortValue', () => {
    const cursor = encodeCursor({ id: 'entity-1', sortValue: 0.95 });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('entity-1');
    expect(decoded.sortValue).toBe(0.95);
  });

  it('encodes and decodes a cursor with id only (no sortValue)', () => {
    const cursor = encodeCursor({ id: 'entity-1' });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('entity-1');
    expect(decoded.sortValue).toBeUndefined();
  });

  it('throws on invalid cursor string', () => {
    expect(() => decodeCursor('not-valid-base64-json')).toThrow();
  });

  it('produces URL-safe base64', () => {
    const cursor = encodeCursor({ id: 'test+value/here=now', sortValue: 'data' });
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('=');
  });
});
```

- [ ] **Step 2: Implement cursor utility**

```typescript
// packages/shared/src/cursor.ts
import { ValidationError } from './errors.js';

export interface CursorPayload {
  id: string;
  sortValue?: string | number;
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    if (!parsed.id || typeof parsed.id !== 'string') {
      throw new Error('Invalid cursor: missing id');
    }
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError('Invalid cursor format');
  }
}
```

- [ ] **Step 3: Export from barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export { encodeCursor, decodeCursor } from './cursor.js';
export type { CursorPayload } from './cursor.js';
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/shared test -- --run cursor
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/cursor.ts packages/shared/tests/unit/cursor.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add cursor encoding/decoding utility for opaque pagination"
```

---

## Task 3: RedisCache Class

**Files:**

- Create: `packages/db/src/cache.ts`
- Create: `packages/db/tests/unit/cache.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/db/tests/unit/cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCache } from '../../src/cache.js';
import type Redis from 'ioredis';

function createMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    scan: vi.fn(),
    del: vi.fn(),
  } as unknown as Redis;
}

describe('RedisCache', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: RedisCache;

  beforeEach(() => {
    redis = createMockRedis();
    cache = new RedisCache(redis as any);
  });

  describe('getOrFetch', () => {
    it('returns cached value on hit', async () => {
      (redis as any).get.mockResolvedValue(JSON.stringify({ version: 1 }));

      const result = await cache.getOrFetch(
        'schema:job-1:current',
        async () => {
          throw new Error('fetcher should not be called');
        },
        30,
      );

      expect(result).toEqual({ version: 1 });
      expect((redis as any).set).not.toHaveBeenCalled();
    });

    it('calls fetcher on miss and caches result', async () => {
      (redis as any).get.mockResolvedValue(null);
      (redis as any).set.mockResolvedValue('OK');

      const fetcher = vi.fn().mockResolvedValue({ version: 2 });
      const result = await cache.getOrFetch('schema:job-1:current', fetcher, 30);

      expect(result).toEqual({ version: 2 });
      expect(fetcher).toHaveBeenCalledOnce();
      expect((redis as any).set).toHaveBeenCalledWith(
        'cache:schema:job-1:current',
        JSON.stringify({ version: 2 }),
        'EX',
        30,
      );
    });

    it('returns fetcher result when Redis is unavailable', async () => {
      (redis as any).get.mockRejectedValue(new Error('connection refused'));
      const fetcher = vi.fn().mockResolvedValue({ fallback: true });

      const result = await cache.getOrFetch('key', fetcher, 30);
      expect(result).toEqual({ fallback: true });
    });
  });

  describe('invalidate', () => {
    it('deletes keys matching pattern using SCAN', async () => {
      (redis as any).scan
        .mockResolvedValueOnce(['10', ['cache:schema:job-1:current', 'cache:schema:job-1:v2']])
        .mockResolvedValueOnce(['0', []]);
      (redis as any).del.mockResolvedValue(2);

      await cache.invalidate('schema:job-1:*');
      expect((redis as any).del).toHaveBeenCalledWith(
        'cache:schema:job-1:current',
        'cache:schema:job-1:v2',
      );
    });

    it('handles no matching keys gracefully', async () => {
      (redis as any).scan.mockResolvedValue(['0', []]);
      await expect(cache.invalidate('nonexistent:*')).resolves.not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Implement RedisCache**

```typescript
// packages/db/src/cache.ts
import type Redis from 'ioredis';
import { createLogger } from '@spatula/shared';

const logger = createLogger('redis-cache');
const KEY_PREFIX = 'cache:';

export class RedisCache {
  constructor(private readonly redis: Redis) {}

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const cacheKey = `${KEY_PREFIX}${key}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch (err) {
      logger.warn({ err, key }, 'Cache read failed, falling through to fetcher');
    }

    const value = await fetcher();

    try {
      await this.redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'Cache write failed');
    }

    return value;
  }

  async invalidate(pattern: string): Promise<void> {
    const cachePattern = `${KEY_PREFIX}${pattern}`;
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          cachePattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.warn({ err, pattern }, 'Cache invalidation failed');
    }
  }
}
```

- [ ] **Step 3: Export from barrel**

Add to `packages/db/src/index.ts`:

```typescript
export { RedisCache } from './cache.js';
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/db test -- --run cache
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/cache.ts packages/db/tests/unit/cache.test.ts packages/db/src/index.ts
git commit -m "feat(db): add RedisCache with read-through getOrFetch and pattern invalidation"
```

---

## Task 4: Pagination Schema Extension

**Files:**

- Modify: `apps/api/src/schemas/pagination.ts`

- [ ] **Step 1: Extend pagination schema with cursor and since**

Read `apps/api/src/schemas/pagination.ts`. Add `cursor` and `since` fields:

```typescript
import { z } from '@hono/zod-openapi';

export const paginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().optional().openapi({
    description: 'Opaque cursor for keyset pagination. Mutually exclusive with offset.',
    example: 'eyJpZCI6Ijk4NzYifQ',
  }),
  since: z.string().datetime().optional().openapi({
    description:
      'ISO 8601 timestamp for incremental fetch. Returns records updated after this time.',
    example: '2026-03-21T14:32:00Z',
  }),
});

export type PaginationParams = z.infer<typeof paginationSchema>;
```

- [ ] **Step 2: Run existing pagination tests**

```bash
pnpm --filter @spatula/api test -- --run pagination
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/pagination.ts
git commit -m "feat(api): extend pagination schema with cursor and since parameters"
```

---

## Task 5: Repository Cursor Methods + updated_at Writes

**Files:**

- Modify: `packages/db/src/repositories/extraction-repository.ts`
- Modify: `packages/db/src/repositories/action-repository.ts`
- Modify: `packages/db/src/repositories/export-repository.ts`
- Modify: `packages/db/src/repositories/entity-repository.ts`

- [ ] **Step 1: Add findByCursor to ExtractionRepository**

Read the file. Add a method similar to `EntityRepository.findByJobCursor`:

```typescript
  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
  ) {
    try {
      const conditions = [eq(extractions.jobId, jobId), eq(extractions.tenantId, tenantId)];
      if (cursor) {
        conditions.push(sql`${extractions.id} > ${cursor}`);
      }
      if (since) {
        conditions.push(sql`${extractions.updatedAt} > ${since}`);
      }

      const rows = await this.db
        .select()
        .from(extractions)
        .where(and(...conditions))
        .orderBy(extractions.id)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
      return { entities: rows, nextCursor };  // Match EntityRepository naming convention
    } catch (error) {
      throw new StorageError(`Failed to fetch extractions by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }
```

Also update `store()` to set `updatedAt`:

```typescript
    // In the values object, add:
    updatedAt: new Date(),
```

- [ ] **Step 2: Add findByCursor to ActionRepository**

Same pattern. Read the file, add `findByJobCursor` with `since` parameter. Also add `countByJob()` method (currently missing — needed for `pagination.total` in API response):

```typescript
  async countByJob(jobId: string, tenantId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(actions)
      .where(and(eq(actions.jobId, jobId), eq(actions.tenantId, tenantId)));
    return result?.count ?? 0;
  }
```

Update ALL mutation methods (`create()`, `updateStatus()`, `batchUpdateStatus()`) to set `updatedAt: new Date()`.

- [ ] **Step 3: Add findByCursor to ExportRepository**

Same pattern. Read the file, add `findByJobCursor` with `since` parameter. Also add `countByJob()` method (currently missing). Update ALL write methods (`create()`, `updateStatus()`) to set `updatedAt: new Date()`.

- [ ] **Step 4: Update EntityRepository for since parameter**

Read `packages/db/src/repositories/entity-repository.ts`. Update the existing `findByJobCursor` to accept an optional `since` parameter:

```typescript
  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
  ) {
```

Add the `since` filter:

```typescript
if (since) {
  conditions.push(sql`${entities.updatedAt} > ${since}`);
}
```

Update ALL mutation methods to set `updatedAt: new Date()`: `create()`, `updateMergedData()` (if exists), `updateQualityScore()` (if exists). Read the file to identify all mutation methods — every write must update `updatedAt` for `?since=` to work correctly.

- [ ] **Step 5: Add tests for cursor methods**

Add tests to at least one repository test file (e.g., `packages/db/tests/unit/repositories/extraction-repository.test.ts` or the entity repo test file). Tests needed:

1. `findByJobCursor` returns `{ entities, nextCursor }` — nextCursor is last ID when batch is full
2. `findByJobCursor` with `since` parameter filters by updatedAt
3. `findByJobCursor` returns `nextCursor: null` on last page
4. `countByJob` returns correct count (for ActionRepository/ExportRepository)

Follow the existing mock-db test patterns in the repository test files.

- [ ] **Step 6: Build and test**

```bash
pnpm --filter @spatula/db build && pnpm --filter @spatula/db test
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/ packages/db/tests/
git commit -m "feat(db): add cursor methods with since filter to all list repositories"
```

---

## Task 6: Apply Cursor Pagination to API Endpoints

**Files:**

- Modify: `apps/api/src/routes/entities.ts`
- Modify: `apps/api/src/routes/extractions.ts`
- Modify: `apps/api/src/routes/actions.ts`
- Modify: `apps/api/src/routes/exports.ts`

- [ ] **Step 1: Update entity list endpoint**

Read `apps/api/src/routes/entities.ts`. The list handler currently uses offset pagination. Add cursor support:

```typescript
import { decodeCursor, encodeCursor } from '@spatula/shared';
```

In the list handler, check if `cursor` is provided. If so, use `findByJobCursor` instead of `findByJob`:

```typescript
if (query.cursor) {
  const { id: cursorId } = decodeCursor(query.cursor);
  const result = await deps.entityRepo.findByJobCursor(
    jobId,
    tenantId,
    query.limit,
    cursorId,
    query.since,
  );
  const total = await deps.entityRepo.countByJob(jobId, tenantId);
  return c.json({
    data: result.entities,
    pagination: {
      total,
      limit: query.limit,
      hasMore: !!result.nextCursor,
      nextCursor: result.nextCursor ? encodeCursor({ id: result.nextCursor }) : undefined,
    },
  });
}

// Fallback: existing offset pagination (also returns pagination envelope for consistency)
```

Update the `listEntitiesRoute` OpenAPI response to include the pagination envelope with `nextCursor` and `hasMore`.

**Important: Consistent response envelope.** The offset path must also return the `pagination` object (with `hasMore: offset + limit < total`, no `nextCursor`). Both paths return `{ data: [...], pagination: { total, limit, hasMore, nextCursor? } }`. Update the existing offset response from `{ data, total }` to `{ data, pagination: { total, limit, hasMore: false } }`.

Also add `since` support to the offset path by passing it to the repository if available.

- [ ] **Step 2: Update extraction list endpoint**

Same pattern. Read `apps/api/src/routes/extractions.ts`, add cursor + since support.

- [ ] **Step 3: Update action list endpoint**

Read `apps/api/src/routes/actions.ts`. **Important:** The actions route defines its OWN inline query schema (`listActionsQuery`) with `type`, `status`, `limit`, `offset` — it does NOT extend `paginationSchema`. Refactor it to extend `paginationSchema` so `cursor` and `since` are available:

```typescript
import { paginationSchema } from '../schemas/pagination.js';

const listActionsQuery = paginationSchema.extend({
  type: z.string().optional(),
  status: z.enum([...actionStatusEnum.enumValues]).optional(),
});
```

Then add cursor support in the handler following the same pattern as entities.

- [ ] **Step 4: Create export list endpoint with cursor pagination**

There is NO existing `GET /exports` list endpoint in `apps/api/src/routes/exports.ts` — only trigger/status/download/docs. Create a new list route:

```typescript
const listExportsRoute = createRoute({
  method: 'get',
  path: '/exports',
  tags: ['Exports'],
  summary: 'List exports for a job',
  request: {
    params: jobIdParam,
    query: paginationSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        data: z.array(exportResponseSchema),
        pagination: z.object({
          total: z.number(),
          limit: z.number(),
          hasMore: z.boolean(),
          nextCursor: z.string().optional(),
        }),
      }),
      'Export list',
    ),
  },
});
```

Implement with cursor support from the start (following same pattern as other endpoints). Use `deps.exportRepo.findByJobCursor()` when cursor is provided, `deps.exportRepo.findByJob()` for offset fallback.

- [ ] **Step 5: Run all API tests**

```bash
pnpm --filter @spatula/api test
```

All existing tests must pass. Cursor is opt-in — existing requests without `cursor` param use offset.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/
git commit -m "feat(api): add cursor pagination and incremental fetch to all list endpoints"
```

---

## Task 7: Cache Wiring

**Files:**

- Modify: `apps/api/src/types.ts`
- Modify: `packages/db/src/repositories/schema-repository.ts`
- Modify: `packages/db/src/repositories/job-repository.ts`
- Modify: `packages/db/src/repositories/tenant-repository.ts`
- Modify: `packages/db/src/repositories/entity-repository.ts`

- [ ] **Step 1: Add cache to AppDeps**

In `apps/api/src/types.ts`, add:

```typescript
import type { RedisCache } from '@spatula/db';
```

Add to `AppDeps`:

```typescript
  cache?: RedisCache;
```

- [ ] **Step 2: Wire cache into schema lookups**

Read `packages/db/src/repositories/schema-repository.ts`. The `findLatest` method is called frequently. Add optional cache support:

Add a `setCache(cache)` method or accept cache in constructor. On `findLatest`, use cache:

```typescript
  private cache?: RedisCache;

  setCache(cache: RedisCache): void {
    this.cache = cache;
  }

  async findLatest(jobId: string, tenantId: string) {
    if (this.cache) {
      return this.cache.getOrFetch(
        `schema:${jobId}:current`,
        () => this.findLatestUncached(jobId, tenantId),
        30,
      );
    }
    return this.findLatestUncached(jobId, tenantId);
  }

  private async findLatestUncached(jobId: string, tenantId: string) {
    // ... existing findLatest logic
  }
```

On schema writes (`create`), invalidate:

```typescript
if (this.cache) {
  void this.cache.invalidate(`schema:${jobId}:*`).catch(() => {});
}
```

- [ ] **Step 3: Wire cache into job config lookups**

Read `packages/db/src/repositories/job-repository.ts`. The `findById` method returns job config which is frequently read. Add cache support same pattern as schema:

```typescript
  async findById(jobId: string, tenantId: string) {
    if (this.cache) {
      return this.cache.getOrFetch(
        `job:${jobId}:config`,
        () => this.findByIdUncached(jobId, tenantId),
        60,
      );
    }
    return this.findByIdUncached(jobId, tenantId);
  }
```

On job status updates (`updateStatus`, `updateStats`), invalidate:

```typescript
if (this.cache) {
  void this.cache.invalidate(`job:${jobId}:*`).catch(() => {});
}
```

- [ ] **Step 4: Wire cache into tenant quota lookups**

In `packages/db/src/repositories/tenant-repository.ts`, wrap `getQuotas` with cache:

```typescript
  async getQuotas(tenantId: string) {
    if (this.cache) {
      return this.cache.getOrFetch(
        `tenant:${tenantId}:quotas`,
        () => this.getQuotasUncached(tenantId),
        300,
      );
    }
    return this.getQuotasUncached(tenantId);
  }
```

On `update`, invalidate:

```typescript
if (this.cache) {
  void this.cache.invalidate(`tenant:${id}:*`).catch(() => {});
}
```

- [ ] **Step 5: Wire cache into entity count**

In `packages/db/src/repositories/entity-repository.ts`, wrap `countByJob` with cache:

```typescript
  async countByJob(jobId: string, tenantId: string, options?: { search?: string }) {
    // Only cache when no search filter (search changes results)
    if (this.cache && !options?.search) {
      return this.cache.getOrFetch(
        `entity-count:${jobId}`,
        () => this.countByJobUncached(jobId, tenantId, options),
        10,
      );
    }
    return this.countByJobUncached(jobId, tenantId, options);
  }
```

On `create`, invalidate:

```typescript
if (this.cache) {
  void this.cache.invalidate(`entity-count:${input.jobId}`).catch(() => {});
}
```

- [ ] **Step 6: Build and test**

```bash
pnpm --filter @spatula/db build && pnpm --filter @spatula/db test
```

Cache is optional (`setCache` not called in tests), so existing tests pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/types.ts packages/db/src/repositories/
git commit -m "feat: wire RedisCache to schema, job config, quota, and entity count hot paths"
```

---

## Task 8: Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm --filter @spatula/api test && pnpm --filter @spatula/db test && pnpm --filter @spatula/shared test && pnpm --filter @spatula/queue test && pnpm --filter @spatula/core test
```

- [ ] **Step 2: Verify new test counts**

Expected new tests:

- Cursor encoding: 5 tests
- RedisCache: 5 tests
- Plus any new tests for cursor endpoints

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues in query and caching"
```
