# Phase 11d: API Hardening & Developer Experience — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Spatula API with REST conventions, add auto-generated OpenAPI documentation, and enable programmatic tenant management with existence validation.

**Architecture:** Four independent improvements that transform the API from a functional prototype into a production-grade surface. REST semantics cleanup adds idiomatic PATCH/DELETE endpoints for jobs. Pagination consistency normalises list endpoints. A tenant repository + middleware enables DB-backed tenant validation (currently the `x-tenant-id` header is trusted blindly). Finally, `@hono/zod-openapi` converts all routes to generate an OpenAPI 3.1 spec from existing Zod schemas, with Swagger UI for interactive exploration.

**Tech Stack:** TypeScript, Hono, @hono/zod-openapi, @hono/swagger-ui, Drizzle ORM, Zod, Vitest

---

## Prerequisites

- Phase 11a complete (migrations, repositories, E2E)
- Design spec: `docs/superpowers/specs/2026-03-17-phase-11-production-hardening-design.md` (section 11d)

## Dependency Graph

```
Task 1 (PATCH)  ──┐
Task 2 (DELETE) ──┤
Task 3 (Pagination)──┤──→ Task 6 (OpenAPI infra) ──→ Task 7 (Route conversion)
Task 4 (Tenant repo) ──→ Task 5 (Tenant routes) ──┘
```

- **Wave 1 (parallel):** Tasks 1, 2, 3, 4
- **Wave 2:** Task 5 (needs Task 4)
- **Wave 3:** Task 6 (needs Tasks 1–5)
- **Wave 4:** Task 7 (needs Task 6)

## File Map

```
Created:
  apps/api/src/schemas/responses.ts                      — OpenAPI response entity schemas
  apps/api/src/schemas/tenant.ts                         — Tenant request/response schemas
  apps/api/src/routes/tenants.ts                         — Tenant CRUD routes
  apps/api/src/middleware/validate-tenant.ts              — DB-backed tenant existence check
  packages/db/src/repositories/tenant-repository.ts      — Tenant CRUD repository

  apps/api/tests/unit/routes/jobs.test.ts                — PATCH + DELETE endpoint tests
  packages/db/tests/unit/repositories/tenant-repository.test.ts
  apps/api/tests/unit/routes/tenants.test.ts
  apps/api/tests/unit/middleware/validate-tenant.test.ts

Modified:
  apps/api/src/schemas/job.ts                            — Add patchJobSchema, offset to list query
  apps/api/src/routes/jobs.ts                            — Add PATCH + DELETE endpoints
  apps/api/src/routes/extractions.ts                     — Refactor to use shared paginationSchema
  apps/api/src/app.ts                                    — OpenAPIHono, tenant routes, doc endpoints
  apps/api/src/types.ts                                  — Add tenantRepo to AppDeps
  apps/api/src/middleware/tenant.ts                       — Add doc paths to SKIP_PATHS
  apps/api/package.json                                  — Add @hono/zod-openapi, @hono/swagger-ui
  packages/db/src/repositories/job-repository.ts         — Add deleteWithData method
  packages/db/src/repositories/index.ts                  — Export TenantRepository
  packages/db/src/index.ts                               — Export TenantRepository

  apps/api/src/routes/schemas.ts                         — OpenAPI route conversion
  apps/api/src/routes/entities.ts                        — OpenAPI route conversion
  apps/api/src/routes/actions.ts                         — OpenAPI route conversion
  apps/api/src/routes/exports.ts                         — OpenAPI route conversion
```

---

## Task 1: PATCH Job Control Endpoint

**Files:**
- Modify: `apps/api/src/schemas/job.ts`
- Modify: `apps/api/src/routes/jobs.ts`
- Create: `apps/api/tests/unit/routes/jobs.test.ts`

This adds a single idiomatic `PATCH /api/v1/jobs/:id` endpoint that replaces the five separate POST action routes. Existing POST routes remain as backwards-compatible aliases.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/unit/routes/jobs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
  return {
    jobRepo: { findById: vi.fn(), findByTenant: vi.fn(), create: vi.fn(), updateStatus: vi.fn(), updateStats: vi.fn() } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
  };
}

describe('PATCH /api/v1/jobs/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('dispatches start action to jobManager', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    const body = await res.json();
    expect(body.data.action).toBe('start');
  });

  it('dispatches pause action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.pauseJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('rejects invalid action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invalid' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects missing action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/jobs.test.ts`
Expected: FAIL — PATCH route not defined yet

- [ ] **Step 3: Add patchJobSchema**

In `apps/api/src/schemas/job.ts`, add after `listJobsQuerySchema`:

```typescript
export const patchJobSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel', 'reconcile']),
});

export type PatchJobBody = z.infer<typeof patchJobSchema>;
```

- [ ] **Step 4: Add PATCH route handler**

In `apps/api/src/routes/jobs.ts`, add import for `patchJobSchema` and `PatchJobBody`, then add before `return router`:

```typescript
import { createJobSchema, listJobsQuerySchema, patchJobSchema } from '../schemas/job.js';
import type { CreateJobBody, ListJobsQuery, PatchJobBody } from '../schemas/job.js';

// ... existing routes ...

// PATCH /:id — Unified job control
router.patch('/:id', validateBody(patchJobSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');
  const jobId = c.req.param('id');
  const { action } = c.get('validatedBody') as PatchJobBody;

  const handlers: Record<string, () => Promise<void>> = {
    start: () => deps.jobManager.startJob(jobId, tenantId),
    pause: () => deps.jobManager.pauseJob(jobId, tenantId),
    resume: () => deps.jobManager.resumeJob(jobId, tenantId),
    cancel: () => deps.jobManager.cancelJob(jobId, tenantId),
    reconcile: () => deps.jobManager.triggerReconciliation(jobId, tenantId),
  };

  await handlers[action]();
  return c.json({ data: { id: jobId, action, message: `Job ${action} successful` } });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/jobs.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/schemas/job.ts apps/api/src/routes/jobs.ts apps/api/tests/unit/routes/jobs.test.ts
git commit -m "feat(api): add PATCH /jobs/:id unified job control endpoint"
```

---

## Task 2: Cascading Job DELETE

**Files:**
- Modify: `packages/db/src/repositories/job-repository.ts`
- Modify: `apps/api/src/routes/jobs.ts`
- Modify: `apps/api/tests/unit/routes/jobs.test.ts`

The DELETE endpoint cascades through all FK-dependent tables in a single transaction. The circular FK between `jobs.schemaId → schemas.id` and `schemas.jobId → jobs.id` requires NULLing `jobs.schemaId` first. Content store entries (referenced by text `contentRef` fields, not FKs) are cleaned up as best-effort.

**FK dependency chain (delete order):**
```
1. NULL jobs.schemaId                (break circular ref)
2. entity_sources                    (FK → entities + extractions)
3. entities                          (FK → jobs)
4. extractions                       (FK → raw_pages → crawl_tasks → jobs)
5. raw_pages                         (FK → crawl_tasks → jobs)
6. crawl_tasks                       (FK → jobs, self-ref parentTaskId — single DELETE is safe)
7. actions                           (FK → jobs)
8. source_trust                      (FK → jobs)
9. schemas                           (FK → jobs, safe now)
10. exports                          (FK → jobs)
11. content_store entries            (text refs, best-effort cleanup)
12. jobs                             (finally safe)
```

- [ ] **Step 1: Write failing test for deleteWithData**

Add to a new test file or extend existing. Since job-repository tests may not exist yet, add DELETE tests to `apps/api/tests/unit/routes/jobs.test.ts`:

```typescript
describe('DELETE /api/v1/jobs/:id', () => {
  it('returns 204 on successful delete', async () => {
    const deps = createMockDeps();
    (deps.jobRepo as any).deleteWithData = vi.fn();
    const app = createApp(deps);

    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'DELETE',
      headers: { 'x-tenant-id': TENANT_ID },
    });

    expect(res.status).toBe(204);
    expect(deps.jobRepo.deleteWithData).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('propagates not-found errors', async () => {
    const deps = createMockDeps();
    const { StorageError } = await import('@spatula/shared');
    (deps.jobRepo as any).deleteWithData = vi.fn().mockRejectedValue(
      new StorageError('Job not found', { context: {} })
    );
    const app = createApp(deps);

    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'DELETE',
      headers: { 'x-tenant-id': TENANT_ID },
    });

    expect(res.status).toBe(500); // StorageError maps to 500 by default
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/jobs.test.ts`
Expected: FAIL — DELETE route not defined, deleteWithData not defined

- [ ] **Step 3: Implement deleteWithData in JobRepository**

In `packages/db/src/repositories/job-repository.ts`, add imports and the new method:

```typescript
import { eq, and, desc, inArray } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { JobConfig, JobStatus } from '@spatula/core';
import { jobs } from '../schema/jobs.js';
import { crawlTasks } from '../schema/crawl-tasks.js';
import { rawPages } from '../schema/raw-pages.js';
import { extractions } from '../schema/extractions.js';
import { entities } from '../schema/entities.js';
import { entitySources } from '../schema/entities.js';
import { actions } from '../schema/actions.js';
import { sourceTrust } from '../schema/source-trust.js';
import { schemasTable } from '../schema/schemas.js';
import { exports } from '../schema/exports.js';
import { contentStore } from '../schema/content.js';
import type { Database } from '../connection.js';

// ... existing code ...

  async deleteWithData(jobId: string, tenantId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // Verify job exists and belongs to tenant
        const [job] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.id, jobId), eq(jobs.tenantId, tenantId)));

        if (!job) {
          throw new StorageError(`Job ${jobId} not found`, {
            context: { jobId, tenantId },
          });
        }

        // 1. Break circular FK: NULL out schemaId
        await tx
          .update(jobs)
          .set({ schemaId: null })
          .where(eq(jobs.id, jobId));

        // 2. Collect content refs for later cleanup
        const taskSubq = tx
          .select({ id: crawlTasks.id })
          .from(crawlTasks)
          .where(eq(crawlTasks.jobId, jobId));

        const pageRefRows = await tx
          .select({ contentRef: rawPages.contentRef })
          .from(rawPages)
          .where(inArray(rawPages.taskId, taskSubq));

        const taskRefRows = await tx
          .select({ contentRef: crawlTasks.contentRef })
          .from(crawlTasks)
          .where(eq(crawlTasks.jobId, jobId));

        const exportRefRows = await tx
          .select({ contentRef: exports.contentRef })
          .from(exports)
          .where(eq(exports.jobId, jobId));

        // 3. Delete entity_sources (FK to entities + extractions)
        const entitySubq = tx
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.jobId, jobId));

        await tx.delete(entitySources).where(inArray(entitySources.entityId, entitySubq));

        // 4. Delete entities
        await tx.delete(entities).where(eq(entities.jobId, jobId));

        // 5. Delete extractions (via raw_pages → crawl_tasks)
        const pageSubq = tx
          .select({ id: rawPages.id })
          .from(rawPages)
          .where(inArray(rawPages.taskId, taskSubq));

        await tx.delete(extractions).where(inArray(extractions.pageId, pageSubq));

        // 6. Delete raw_pages
        await tx.delete(rawPages).where(inArray(rawPages.taskId, taskSubq));

        // 7. Delete crawl_tasks (self-ref parentTaskId safe in single DELETE)
        await tx.delete(crawlTasks).where(eq(crawlTasks.jobId, jobId));

        // 8. Delete actions
        await tx.delete(actions).where(eq(actions.jobId, jobId));

        // 9. Delete source_trust
        await tx.delete(sourceTrust).where(eq(sourceTrust.jobId, jobId));

        // 10. Delete schemas (safe now — schemaId is NULL)
        await tx.delete(schemasTable).where(eq(schemasTable.jobId, jobId));

        // 11. Delete exports
        await tx.delete(exports).where(eq(exports.jobId, jobId));

        // 12. Best-effort content store cleanup
        const allRefs = [
          ...pageRefRows.map((r) => r.contentRef),
          ...taskRefRows.map((r) => r.contentRef),
          ...exportRefRows.map((r) => r.contentRef),
        ].filter((ref): ref is string => ref != null && ref.startsWith('pg://'));

        if (allRefs.length > 0) {
          const contentIds = allRefs.map((ref) => ref.slice(5));
          await tx.delete(contentStore).where(inArray(contentStore.id, contentIds));
        }

        // 13. Delete the job itself
        await tx.delete(jobs).where(eq(jobs.id, jobId));

        logger.info({ jobId, tenantId }, 'job and all related data deleted');
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to delete job ${jobId}: ${(error as Error).message}`,
        { cause: error as Error, context: { jobId, tenantId } },
      );
    }
  }
```

- [ ] **Step 4: Add DELETE route handler**

In `apps/api/src/routes/jobs.ts`, add before `return router`:

```typescript
  // DELETE /:id — Delete job with all related data
  router.delete('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobRepo.deleteWithData(jobId, tenantId);
    return c.body(null, 204);
  });
```

- [ ] **Step 5: Update AppDeps type to include deleteWithData**

The `AppDeps` interface references `JobRepository` via the imported type. Since `deleteWithData` is a new method on the existing `JobRepository` class, the type automatically includes it. No changes needed to `types.ts` — the mock in tests just needs the method added.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/jobs.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/job-repository.ts apps/api/src/routes/jobs.ts apps/api/tests/unit/routes/jobs.test.ts
git commit -m "feat(api,db): add DELETE /jobs/:id with cascading delete through all FK-dependent tables"
```

---

## Task 3: Pagination Consistency

**Files:**
- Modify: `apps/api/src/schemas/job.ts`
- Modify: `apps/api/src/routes/jobs.ts`
- Modify: `apps/api/src/routes/extractions.ts`

Two small fixes: add `offset` to the jobs list query, and refactor extractions to reuse the shared `paginationSchema`.

- [ ] **Step 1: Add offset to listJobsQuerySchema**

In `apps/api/src/schemas/job.ts`, replace `listJobsQuerySchema`:

```typescript
export const listJobsQuerySchema = z.object({
  status: z
    .enum(['pending', 'queued', 'running', 'paused', 'reconciling', 'completed', 'failed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});
```

- [ ] **Step 2: Pass offset to repository in jobs route**

In `apps/api/src/routes/jobs.ts`, update the GET / handler:

```typescript
    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
```

- [ ] **Step 3: Add offset support to JobRepository.findByTenant**

In `packages/db/src/repositories/job-repository.ts`, update the `findByTenant` method options type and implementation:

```typescript
  async findByTenant(
    tenantId: string,
    options?: { status?: JobStatus; limit?: number; offset?: number },
  ) {
    try {
      let query = this.db
        .select()
        .from(jobs)
        .where(
          options?.status
            ? and(eq(jobs.tenantId, tenantId), eq(jobs.status, options.status))
            : eq(jobs.tenantId, tenantId),
        )
        .orderBy(desc(jobs.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to list jobs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
```

- [ ] **Step 4: Add offset support to ExtractionRepository.findByJob**

In `packages/db/src/repositories/extraction-repository.ts`, update the options type and add offset:

```typescript
  async findByJob(
    jobId: string,
    tenantId: string,
    options?: { schemaVersion?: number; limit?: number; offset?: number },
  ) {
    try {
      const conditions = [eq(extractions.jobId, jobId), eq(extractions.tenantId, tenantId)];
      if (options?.schemaVersion !== undefined) {
        conditions.push(eq(extractions.schemaVersion, options.schemaVersion));
      }

      let query = this.db
        .select()
        .from(extractions)
        .where(and(...conditions))
        .orderBy(desc(extractions.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find extractions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }
```

- [ ] **Step 5: Refactor extractions query to use shared paginationSchema**

Replace the entire `apps/api/src/routes/extractions.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import { validateQuery } from '../middleware/validate.js';
import { z } from 'zod';

const listExtractionsQuery = paginationSchema.extend({
  schemaVersion: z.coerce.number().int().min(1).optional(),
});

export function extractionRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', validateQuery(listExtractionsQuery), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as z.infer<typeof listExtractionsQuery>;

    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      schemaVersion: query.schemaVersion,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: extractions });
  });

  return router;
}
```

- [ ] **Step 6: Verify build passes**

Run: `cd apps/api && pnpm build`
Expected: PASS (no type errors)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/schemas/job.ts apps/api/src/routes/jobs.ts apps/api/src/routes/extractions.ts packages/db/src/repositories/job-repository.ts packages/db/src/repositories/extraction-repository.ts
git commit -m "fix(api): add offset to jobs list query, refactor extractions to use shared paginationSchema"
```

---

## Task 4: Tenant Repository

**Files:**
- Create: `packages/db/src/repositories/tenant-repository.ts`
- Create: `packages/db/tests/unit/repositories/tenant-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Modify: `packages/db/src/index.ts`

The tenants table already exists (`packages/db/src/schema/tenants.ts`). This task adds a repository with `create`, `findById`, and `update` methods following the existing repository pattern.

- [ ] **Step 1: Write failing tests**

Create `packages/db/tests/unit/repositories/tenant-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantRepository } from '../../../src/repositories/tenant-repository.js';

// Mock database that captures calls
function createMockDb() {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    _mocks: { mockReturning, mockWhere, mockSet, mockValues },
  };

  return db;
}

describe('TenantRepository', () => {
  describe('create', () => {
    it('inserts a tenant with name and optional config', async () => {
      const db = createMockDb();
      db._mocks.mockReturning.mockResolvedValue([
        { id: 'tenant-1', name: 'Test Corp', config: {}, createdAt: new Date() },
      ]);

      const repo = new TenantRepository(db as any);
      const result = await repo.create({ name: 'Test Corp' });

      expect(result.id).toBe('tenant-1');
      expect(result.name).toBe('Test Corp');
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      const db = createMockDb();
      const repo = new TenantRepository(db as any);
      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('updates tenant fields and returns updated row', async () => {
      const db = createMockDb();
      db._mocks.mockReturning.mockResolvedValue([
        { id: 'tenant-1', name: 'Updated Corp', config: { key: 'val' }, createdAt: new Date() },
      ]);

      const repo = new TenantRepository(db as any);
      const result = await repo.update('tenant-1', { name: 'Updated Corp', config: { key: 'val' } });

      expect(result.name).toBe('Updated Corp');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/tenant-repository.test.ts`
Expected: FAIL — TenantRepository module not found

- [ ] **Step 3: Implement TenantRepository**

Create `packages/db/src/repositories/tenant-repository.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { tenants } from '../schema/tenants.js';
import type { Database } from '../connection.js';

const logger = createLogger('tenant-repository');

export interface CreateTenantInput {
  name: string;
  config?: Record<string, unknown>;
}

export interface UpdateTenantInput {
  name?: string;
  config?: Record<string, unknown>;
}

export class TenantRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateTenantInput) {
    try {
      const [row] = await this.db
        .insert(tenants)
        .values({
          name: input.name,
          config: input.config ?? {},
        })
        .returning();

      logger.debug({ tenantId: row.id }, 'tenant created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create tenant: ${(error as Error).message}`, {
        cause: error as Error,
        context: { name: input.name },
      });
    }
  }

  async findById(id: string) {
    try {
      const [row] = await this.db
        .select()
        .from(tenants)
        .where(eq(tenants.id, id));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find tenant ${id}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id },
      });
    }
  }

  async update(id: string, changes: UpdateTenantInput) {
    try {
      const updates: Record<string, unknown> = {};
      if (changes.name !== undefined) updates.name = changes.name;
      if (changes.config !== undefined) updates.config = changes.config;

      const [row] = await this.db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.id, id))
        .returning();

      if (!row) {
        throw new StorageError(`Tenant ${id} not found`, { context: { id } });
      }

      logger.debug({ tenantId: id }, 'tenant updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update tenant: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id },
      });
    }
  }
}
```

- [ ] **Step 4: Export from barrel files**

In `packages/db/src/repositories/index.ts`, add:

```typescript
export { TenantRepository } from './tenant-repository.js';
export type { CreateTenantInput, UpdateTenantInput } from './tenant-repository.js';
```

Verify `packages/db/src/index.ts` already re-exports via `export * from './repositories/index.js'` — it does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/tenant-repository.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/tenant-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/tenant-repository.test.ts
git commit -m "feat(db): add TenantRepository with create, findById, update methods"
```

---

## Task 5: Tenant API Routes & Middleware

**Files:**
- Create: `apps/api/src/schemas/tenant.ts`
- Create: `apps/api/src/routes/tenants.ts`
- Create: `apps/api/src/middleware/validate-tenant.ts`
- Create: `apps/api/tests/unit/routes/tenants.test.ts`
- Create: `apps/api/tests/unit/middleware/validate-tenant.test.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/middleware/tenant.ts`

Adds tenant CRUD endpoints and DB-backed tenant existence validation. Tenant management routes (`/api/v1/tenants`) skip the `x-tenant-id` requirement since they manage tenants rather than act as a tenant.

- [ ] **Step 1: Add tenantRepo to AppDeps**

In `apps/api/src/types.ts`, add the import and field:

```typescript
import type { TenantRepository } from '@spatula/db';

export interface AppDeps {
  // ... existing fields ...
  tenantRepo?: TenantRepository;
}
```

- [ ] **Step 2: Create tenant request schemas**

Create `apps/api/src/schemas/tenant.ts`:

```typescript
import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  config: z.record(z.unknown()).optional(),
});

export type CreateTenantBody = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
});

export type UpdateTenantBody = z.infer<typeof updateTenantSchema>;
```

- [ ] **Step 3: Write failing tests for tenant routes**

Create `apps/api/tests/unit/routes/tenants.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {} as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      create: vi.fn().mockResolvedValue({
        id: 'new-tenant-id',
        name: 'Test Corp',
        config: {},
        createdAt: new Date(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Existing Corp',
        config: { maxJobs: 10 },
        createdAt: new Date(),
      }),
      update: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Updated Corp',
        config: { maxJobs: 20 },
        createdAt: new Date(),
      }),
    } as any,
  };
}

describe('Tenant routes', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('POST /api/v1/tenants', () => {
    it('creates a tenant without requiring x-tenant-id', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Corp' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe('Test Corp');
    });

    it('rejects empty name', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/tenants/:id', () => {
    it('returns tenant by ID without requiring x-tenant-id', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Existing Corp');
    });

    it('returns 404 for nonexistent tenant', async () => {
      deps.tenantRepo!.findById = vi.fn().mockResolvedValue(null) as any;
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/tenants/:id', () => {
    it('updates tenant name and config', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Corp', config: { maxJobs: 20 } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Corp');
    });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/tenants.test.ts`
Expected: FAIL — tenant routes not mounted

- [ ] **Step 5: Implement tenant routes**

Create `apps/api/src/routes/tenants.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { createTenantSchema, updateTenantSchema } from '../schemas/tenant.js';
import type { CreateTenantBody, UpdateTenantBody } from '../schemas/tenant.js';
import { validateBody } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function tenantRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST / — Create tenant
  router.post('/', validateBody(createTenantSchema), async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const body = c.get('validatedBody') as CreateTenantBody;
    const tenant = await deps.tenantRepo.create(body);
    return c.json({ data: tenant }, 201);
  });

  // GET /:id — Get tenant
  router.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const tenantId = c.req.param('id');
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant', tenantId);
    }

    return c.json({ data: tenant });
  });

  // PATCH /:id — Update tenant
  router.patch('/:id', validateBody(updateTenantSchema), async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const tenantId = c.req.param('id');
    const body = c.get('validatedBody') as UpdateTenantBody;
    const tenant = await deps.tenantRepo.update(tenantId, body);
    return c.json({ data: tenant });
  });

  return router;
}
```

- [ ] **Step 6: Mount tenant routes in app.ts**

In `apps/api/src/app.ts`, add import and mount. Tenant routes skip tenant middleware — mount them with only deps middleware:

```typescript
import { tenantRoutes } from './routes/tenants.js';

// ... inside createApp() ...

  // Tenant management routes (no x-tenant-id required)
  app.use('/api/v1/tenants', depsMiddleware(deps));
  app.use('/api/v1/tenants/*', depsMiddleware(deps));
  app.route('/api/v1/tenants', tenantRoutes());

  // Tenant + deps injection for all other API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));
```

**Important:** The tenant routes must be registered BEFORE the general `/api/*` tenant middleware so they don't require `x-tenant-id`. Move the health check and tenant route mounts above the general middleware:

```typescript
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', honoLogger());
  app.onError(errorHandler);

  // Health check (no auth)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Tenant management routes (no x-tenant-id required, only deps)
  app.use('/api/v1/tenants', depsMiddleware(deps));
  app.use('/api/v1/tenants/*', depsMiddleware(deps));
  app.route('/api/v1/tenants', tenantRoutes());

  // Tenant + deps injection for all other API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));

  // API v1 routes
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  return app;
}
```

- [ ] **Step 7: Implement validate-tenant middleware**

Create `apps/api/src/middleware/validate-tenant.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { NotFoundError } from './error-handler.js';

export const validateTenantMiddleware: MiddlewareHandler = async (c, next) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');

  if (deps.tenantRepo && tenantId) {
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant', tenantId);
    }
  }

  return next();
};
```

Register after deps middleware in `app.ts`:

```typescript
  import { validateTenantMiddleware } from './middleware/validate-tenant.js';

  // ... after tenant + deps middleware ...
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);
```

- [ ] **Step 8: Write validate-tenant middleware test**

Create `apps/api/tests/unit/middleware/validate-tenant.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { validateTenantMiddleware } from '../../../src/middleware/validate-tenant.js';

describe('validateTenantMiddleware', () => {
  it('passes when tenantRepo is not configured', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', {});
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('passes when tenant exists', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', { tenantRepo: { findById: vi.fn().mockResolvedValue({ id: 'tenant-1' }) } });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 404 when tenant does not exist', async () => {
    const app = new Hono();
    app.onError((err, c) => c.json({ error: { message: err.message } }, 404));
    app.use('*', async (c, next) => {
      c.set('tenantId', 'nonexistent');
      c.set('deps', { tenantRepo: { findById: vi.fn().mockResolvedValue(null) } });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 9: Run all tests**

Run: `cd apps/api && pnpm test -- --run`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/schemas/tenant.ts apps/api/src/routes/tenants.ts apps/api/src/middleware/validate-tenant.ts apps/api/src/types.ts apps/api/src/app.ts apps/api/tests/unit/routes/tenants.test.ts apps/api/tests/unit/middleware/validate-tenant.test.ts
git commit -m "feat(api): add tenant CRUD routes and DB-backed tenant validation middleware"
```

---

## Task 6: OpenAPI Infrastructure

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/middleware/tenant.ts`
- Create: `apps/api/src/schemas/responses.ts`

Install `@hono/zod-openapi` and `@hono/swagger-ui`, swap `Hono` to `OpenAPIHono` in `createApp`, add a `defaultHook` for validation errors, and register the `/api/openapi.json` and `/api/docs` endpoints. All existing routes continue working unchanged since `OpenAPIHono` extends `Hono`.

- [ ] **Step 1: Install dependencies**

```bash
cd apps/api && pnpm add @hono/zod-openapi @hono/swagger-ui
```

- [ ] **Step 2: Add doc paths to tenant middleware skip list**

In `apps/api/src/middleware/tenant.ts`, update SKIP_PATHS:

```typescript
const SKIP_PATHS = new Set(['/health', '/api/docs', '/api/openapi.json']);
```

- [ ] **Step 3: Swap Hono to OpenAPIHono in app.ts**

Replace `apps/api/src/app.ts`:

```typescript
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { depsMiddleware } from './middleware/deps.js';
import { validateTenantMiddleware } from './middleware/validate-tenant.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import type { AppDeps, AppEnv } from './types.js';

export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(', '),
              requestId,
            },
          },
          400,
        );
      }
    },
  });

  // Global middleware
  app.use('*', honoLogger());
  app.onError(errorHandler);

  // Health check (no auth)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // OpenAPI documentation (no auth)
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Spatula API',
      version: '1.0.0',
      description: 'AI-powered intelligent web crawling platform',
    },
  });
  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

  // Tenant management routes (no x-tenant-id required, only deps)
  app.use('/api/v1/tenants', depsMiddleware(deps));
  app.use('/api/v1/tenants/*', depsMiddleware(deps));
  app.route('/api/v1/tenants', tenantRoutes());

  // Tenant + deps injection for all other API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // API v1 routes
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  return app;
}
```

- [ ] **Step 4: Create response schemas**

Create `apps/api/src/schemas/responses.ts` — reusable OpenAPI response schemas for all entities:

```typescript
import { z } from '@hono/zod-openapi';

// --- Entity schemas (describe JSON shapes returned by endpoints) ---

export const jobResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  config: z.record(z.unknown()),
  status: z.enum(['pending', 'queued', 'running', 'paused', 'reconciling', 'completed', 'failed', 'cancelled']),
  schemaId: z.string().uuid().nullable(),
  stats: z.record(z.number()).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).openapi('Job');

export const tenantResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  config: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
}).openapi('Tenant');

export const schemaVersionResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  version: z.number().int(),
  definition: z.record(z.unknown()),
  parentId: z.string().uuid().nullable(),
  createdAt: z.string(),
}).openapi('SchemaVersion');

export const extractionResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  pageId: z.string().uuid(),
  schemaVersion: z.number().int(),
  data: z.record(z.unknown()),
  unmappedFields: z.array(z.unknown()).nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
}).openapi('Extraction');

export const entityResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  mergedData: z.record(z.unknown()),
  provenance: z.record(z.unknown()),
  categories: z.array(z.string()),
  qualityScore: z.number(),
  createdAt: z.string(),
}).openapi('Entity');

export const actionResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  type: z.string(),
  payload: z.record(z.unknown()),
  source: z.enum(['extraction', 'schema_evolution', 'reconciliation', 'quality_audit']),
  status: z.enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back']),
  confidence: z.number(),
  reasoning: z.string(),
  stateChanges: z.record(z.unknown()).nullable(),
  reviewedBy: z.string().nullable(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
}).openapi('Action');

export const exportResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  format: z.string(),
  status: z.string(),
  includeProvenance: z.boolean(),
  entityCount: z.number().nullable(),
  contentRef: z.string().nullable(),
  fileSize: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
}).openapi('Export');

// --- Common wrappers ---

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
}).openapi('Error');

export function dataResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export function listResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}

// --- Convenience: common response definitions for createRoute ---

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return {
    content: { 'application/json': { schema } },
    description,
  };
}
```

- [ ] **Step 5: Verify build passes**

Run: `cd apps/api && pnpm build`
Expected: PASS

- [ ] **Step 6: Run all existing tests**

Run: `cd apps/api && pnpm test -- --run`
Expected: PASS (OpenAPIHono is a drop-in replacement for Hono)

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src/app.ts apps/api/src/middleware/tenant.ts apps/api/src/schemas/responses.ts
git commit -m "feat(api): add OpenAPI infrastructure with OpenAPIHono, Swagger UI, and response schemas"
```

---

## Task 7: OpenAPI Route Conversion

**Files:**
- Modify: all route files in `apps/api/src/routes/`
- Modify: all schema files in `apps/api/src/schemas/`

Convert every route file from plain `Hono` to `OpenAPIHono` with `createRoute()` definitions. After conversion, each route has typed request/response schemas, validation is handled by `@hono/zod-openapi` (no more `validateBody`/`validateQuery` middleware), and the OpenAPI spec includes all endpoints.

**Conversion pattern (applied to every route):**

```typescript
// BEFORE:
import { Hono } from 'hono';
router.get('/:id', async (c) => {
  const id = c.req.param('id');
  // ...
});

// AFTER:
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
const getByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: '550e8400-...' }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(entitySchema), 'Success'),
    404: jsonContent(errorResponseSchema, 'Not found'),
  },
});
router.openapi(getByIdRoute, async (c) => {
  const { id } = c.req.valid('param');
  // ... handler logic stays the same
});
```

**Key changes in converted routes:**
- `c.req.param('id')` → `c.req.valid('param').id` (typed from schema)
- `c.get('validatedBody')` → `c.req.valid('json')` (typed from schema)
- `c.get('validatedQuery')` → `c.req.valid('query')` (typed from schema)
- `validateBody(schema)` middleware removed (built into `createRoute`)
- `validateQuery(schema)` middleware removed (built into `createRoute`)

This task is the largest but entirely mechanical. Convert one file at a time, verify build + tests between each.

- [ ] **Step 1: Update schema files to use @hono/zod-openapi z**

In all schema files under `apps/api/src/schemas/`, change:
```typescript
// BEFORE:
import { z } from 'zod';
// AFTER:
import { z } from '@hono/zod-openapi';
```

Files to update:
- `apps/api/src/schemas/job.ts`
- `apps/api/src/schemas/pagination.ts`
- `apps/api/src/schemas/entity-query.ts`
- `apps/api/src/schemas/export-request.ts`
- `apps/api/src/schemas/tenant.ts`

- [ ] **Step 2: Convert jobs.ts**

Replace `apps/api/src/routes/jobs.ts` with the full OpenAPI conversion. This is the reference implementation — other files follow the same pattern.

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { JobConfig } from '@spatula/core';
import type { AppEnv } from '../types.js';
import { createJobSchema, listJobsQuerySchema, patchJobSchema } from '../schemas/job.js';
import { jobResponseSchema, errorResponseSchema, dataResponse, listResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

// --- Route definitions ---

const createJobRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Jobs'],
  summary: 'Create a new crawl job',
  request: {
    body: { content: { 'application/json': { schema: createJobSchema } }, required: true },
  },
  responses: {
    201: jsonContent(dataResponse(jobResponseSchema), 'Job created'),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const listJobsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Jobs'],
  summary: 'List jobs for the current tenant',
  request: {
    query: listJobsQuerySchema,
  },
  responses: {
    200: jsonContent(listResponse(jobResponseSchema), 'List of jobs'),
  },
});

const getJobRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Get job details',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: '550e8400-e29b-41d4-a716-446655440000' }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(jobResponseSchema), 'Job details'),
    404: jsonContent(errorResponseSchema, 'Job not found'),
  },
});

const patchJobRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Control job (start, pause, resume, cancel, reconcile)',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: patchJobSchema } }, required: true },
  },
  responses: {
    200: jsonContent(
      z.object({ data: z.object({ id: z.string(), action: z.string(), message: z.string() }) }),
      'Action executed',
    ),
    400: jsonContent(errorResponseSchema, 'Invalid action'),
  },
});

const deleteJobRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Delete job and all related data',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    204: { description: 'Job deleted' },
    404: jsonContent(errorResponseSchema, 'Job not found'),
  },
});

// Legacy POST action routes (backwards compatibility aliases)
const startJobRoute = createRoute({ method: 'post', path: '/{id}/start', tags: ['Jobs'], summary: 'Start job (alias for PATCH)',
  request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), message: z.string() }) }), 'Job started') },
});
const pauseJobRoute = createRoute({ method: 'post', path: '/{id}/pause', tags: ['Jobs'], summary: 'Pause job (alias for PATCH)',
  request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), message: z.string() }) }), 'Job paused') },
});
const resumeJobRoute = createRoute({ method: 'post', path: '/{id}/resume', tags: ['Jobs'], summary: 'Resume job (alias for PATCH)',
  request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), message: z.string() }) }), 'Job resumed') },
});
const cancelJobRoute = createRoute({ method: 'post', path: '/{id}/cancel', tags: ['Jobs'], summary: 'Cancel job (alias for PATCH)',
  request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), message: z.string() }) }), 'Job cancelled') },
});
const reconcileJobRoute = createRoute({ method: 'post', path: '/{id}/reconcile', tags: ['Jobs'], summary: 'Trigger reconciliation (alias for PATCH)',
  request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), message: z.string() }) }), 'Reconciliation triggered') },
});

// --- Handlers ---

export function jobRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(createJobRoute, async (c) => {
    const body = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const config = JobConfig.parse({ tenantId, ...body });
    const jobId = await deps.jobManager.createJob(config);
    const job = await deps.jobRepo.findById(jobId, tenantId);

    return c.json({ data: job }, 201);
  });

  router.openapi(listJobsRoute, async (c) => {
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: jobs });
  });

  router.openapi(getJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new NotFoundError('Job', id);

    return c.json({ data: job });
  });

  router.openapi(patchJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { action } = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const handlers: Record<string, () => Promise<void>> = {
      start: () => deps.jobManager.startJob(id, tenantId),
      pause: () => deps.jobManager.pauseJob(id, tenantId),
      resume: () => deps.jobManager.resumeJob(id, tenantId),
      cancel: () => deps.jobManager.cancelJob(id, tenantId),
      reconcile: () => deps.jobManager.triggerReconciliation(id, tenantId),
    };

    await handlers[action]();
    return c.json({ data: { id, action, message: `Job ${action} successful` } });
  });

  router.openapi(deleteJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    await deps.jobRepo.deleteWithData(id, tenantId);
    return c.body(null, 204);
  });

  // Legacy POST aliases
  router.openapi(startJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.startJob(id, tenantId);
    return c.json({ data: { id, message: 'Job started' } });
  });
  router.openapi(pauseJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.pauseJob(id, tenantId);
    return c.json({ data: { id, message: 'Job paused' } });
  });
  router.openapi(resumeJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.resumeJob(id, tenantId);
    return c.json({ data: { id, message: 'Job resumed' } });
  });
  router.openapi(cancelJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.cancelJob(id, tenantId);
    return c.json({ data: { id, message: 'Job cancelled' } });
  });
  router.openapi(reconcileJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.triggerReconciliation(id, tenantId);
    return c.json({ data: { id, message: 'Reconciliation triggered' } });
  });

  return router;
}
```

- [ ] **Step 3: Verify build + tests after jobs.ts conversion**

Run: `cd apps/api && pnpm build && pnpm test -- --run`
Expected: PASS

- [ ] **Step 4: Convert schemas.ts**

Replace `apps/api/src/routes/schemas.ts` — key differences from jobs.ts: sub-routes mounted under `/api/v1/jobs/:jobId/schema`, so declare `jobId` as a parent param.

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { schemaVersionResponseSchema, errorResponseSchema, dataResponse, listResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';
import { ValidationError } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const getLatestRoute = createRoute({
  method: 'get', path: '/', tags: ['Schemas'],
  summary: 'Get latest schema version for a job',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(dataResponse(schemaVersionResponseSchema), 'Latest schema'),
    404: jsonContent(errorResponseSchema, 'Schema not found'),
  },
});

const listVersionsRoute = createRoute({
  method: 'get', path: '/versions', tags: ['Schemas'],
  summary: 'List all schema versions',
  request: { params: jobIdParam },
  responses: { 200: jsonContent(listResponse(schemaVersionResponseSchema), 'All schema versions') },
});

const getVersionRoute = createRoute({
  method: 'get', path: '/versions/{version}', tags: ['Schemas'],
  summary: 'Get a specific schema version',
  request: {
    params: jobIdParam.extend({
      version: z.string().openapi({ param: { name: 'version', in: 'path' }, example: '1' }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(schemaVersionResponseSchema), 'Schema version'),
    404: jsonContent(errorResponseSchema, 'Version not found'),
  },
});

export function schemaRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(getLatestRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schema) throw new NotFoundError('Schema', jobId);

    return c.json({ data: schema });
  });

  router.openapi(listVersionsRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const versions = await deps.schemaRepo.findAllVersions(jobId, tenantId);
    return c.json({ data: versions });
  });

  router.openapi(getVersionRoute, async (c) => {
    const { jobId, version: versionStr } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const version = parseInt(versionStr, 10);

    if (isNaN(version) || version < 1) {
      throw new ValidationError('Version must be a positive integer');
    }

    const schema = await deps.schemaRepo.findByVersion(jobId, tenantId, version);
    if (!schema) throw new NotFoundError('Schema version', String(version));

    return c.json({ data: schema });
  });

  return router;
}
```

- [ ] **Step 5: Convert extractions.ts**

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import { extractionResponseSchema, listResponse, jsonContent } from '../schemas/responses.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listExtractionsQuery = paginationSchema.extend({
  schemaVersion: z.coerce.number().int().min(1).optional(),
});

const listRoute = createRoute({
  method: 'get', path: '/', tags: ['Extractions'],
  summary: 'List extractions for a job',
  request: { params: jobIdParam, query: listExtractionsQuery },
  responses: { 200: jsonContent(listResponse(extractionResponseSchema), 'List of extractions') },
});

export function extractionRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      schemaVersion: query.schemaVersion,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: extractions });
  });

  return router;
}
```

- [ ] **Step 6: Convert entities.ts**

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { entityQuerySchema } from '../schemas/entity-query.js';
import { entityResponseSchema, errorResponseSchema, dataResponse, listResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listEntitiesRoute = createRoute({
  method: 'get', path: '/', tags: ['Entities'],
  summary: 'List entities for a job',
  request: { params: jobIdParam, query: entityQuerySchema },
  responses: {
    200: jsonContent(z.object({ data: z.array(entityResponseSchema), total: z.number() }), 'Entities with count'),
  },
});

const getEntityRoute = createRoute({
  method: 'get', path: '/{entityId}', tags: ['Entities'],
  summary: 'Get entity with source details',
  request: {
    params: jobIdParam.extend({
      entityId: z.string().openapi({ param: { name: 'entityId', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(entityResponseSchema.extend({ sources: z.array(z.record(z.unknown())) })), 'Entity with sources'),
    404: jsonContent(errorResponseSchema, 'Entity not found'),
  },
});

export function entityRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(listEntitiesRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const [entities, total] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, {
        limit: query.limit,
        offset: query.offset,
        search: query.search,
      }),
      deps.entityRepo.countByJob(jobId, tenantId, { search: query.search }),
    ]);

    return c.json({ data: entities, total });
  });

  router.openapi(getEntityRoute, async (c) => {
    const { entityId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const entity = await deps.entityRepo.findById(entityId, tenantId);
    if (!entity) throw new NotFoundError('Entity', entityId);

    const sources = await deps.entitySourceRepo.findByEntityWithUrls(entityId);
    return c.json({ data: { ...entity, sources } });
  });

  return router;
}
```

- [ ] **Step 7: Convert actions.ts**

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { actionResponseSchema, errorResponseSchema, listResponse, jsonContent } from '../schemas/responses.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listActionsQuery = z.object({
  type: z.string().optional(),
  status: z.enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back']).optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});

const listRoute = createRoute({
  method: 'get', path: '/', tags: ['Actions'],
  summary: 'List actions for a job',
  request: { params: jobIdParam, query: listActionsQuery },
  responses: { 200: jsonContent(listResponse(actionResponseSchema), 'List of actions') },
});

const approveAllRoute = createRoute({
  method: 'post', path: '/approve-all', tags: ['Actions'],
  summary: 'Batch approve all pending actions',
  request: {
    params: jobIdParam,
    body: { content: { 'application/json': { schema: z.object({ reviewedBy: z.string().optional() }) } } },
  },
  responses: { 200: jsonContent(listResponse(actionResponseSchema), 'Approved actions') },
});

const approveRoute = createRoute({
  method: 'post', path: '/{actionId}/approve', tags: ['Actions'],
  summary: 'Approve a single action',
  request: {
    params: jobIdParam.extend({
      actionId: z.string().openapi({ param: { name: 'actionId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: z.object({ reviewedBy: z.string().optional() }) } } },
  },
  responses: { 200: jsonContent(z.object({ data: actionResponseSchema }), 'Approved action') },
});

const rejectRoute = createRoute({
  method: 'post', path: '/{actionId}/reject', tags: ['Actions'],
  summary: 'Reject an action',
  request: {
    params: jobIdParam.extend({
      actionId: z.string().openapi({ param: { name: 'actionId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: z.object({ reviewedBy: z.string().optional(), reason: z.string().optional() }) } } },
  },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), status: z.string() }) }), 'Rejected') },
});

export function actionRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const actions = await deps.actionRepo.findByJob(jobId, tenantId, {
      type: query.type, status: query.status, limit: query.limit, offset: query.offset,
    });
    return c.json({ data: actions });
  });

  router.openapi(approveAllRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');
    const reviewedBy = body?.reviewedBy;

    if (deps.reviewQueue) {
      const results = await deps.reviewQueue.approveAll(jobId, tenantId, reviewedBy);
      return c.json({ data: results });
    }

    const pending = await deps.actionRepo.findByJob(jobId, tenantId, { status: 'pending_review' });
    const ids = pending.map((a: { id: string }) => a.id);
    if (ids.length === 0) return c.json({ data: [] });

    const updated = await deps.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
    return c.json({ data: updated });
  });

  router.openapi(approveRoute, async (c) => {
    const { actionId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');

    if (deps.reviewQueue) {
      const action = await deps.reviewQueue.approve(actionId, tenantId, body?.reviewedBy);
      return c.json({ data: action });
    }

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'approved', body?.reviewedBy);
    return c.json({ data: action });
  });

  router.openapi(rejectRoute, async (c) => {
    const { actionId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');

    if (deps.reviewQueue) {
      await deps.reviewQueue.reject(actionId, tenantId, body?.reviewedBy, body?.reason ?? '');
      return c.json({ data: { id: actionId, status: 'rejected' } });
    }

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'rejected', body?.reviewedBy);
    return c.json({ data: action });
  });

  return router;
}
```

- [ ] **Step 8: Convert exports.ts**

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { exportRequestSchema } from '../schemas/export-request.js';
import { exportResponseSchema, errorResponseSchema, dataResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError, ConflictError } from '../middleware/error-handler.js';
import { generateDocumentation } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const triggerExportRoute = createRoute({
  method: 'post', path: '/export', tags: ['Exports'],
  summary: 'Trigger data export',
  request: {
    params: jobIdParam,
    body: { content: { 'application/json': { schema: exportRequestSchema } }, required: true },
  },
  responses: { 202: jsonContent(dataResponse(exportResponseSchema), 'Export queued') },
});

const getExportRoute = createRoute({
  method: 'get', path: '/export/{exportId}', tags: ['Exports'],
  summary: 'Check export status',
  request: {
    params: jobIdParam.extend({
      exportId: z.string().openapi({ param: { name: 'exportId', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(exportResponseSchema), 'Export status'),
    404: jsonContent(errorResponseSchema, 'Export not found'),
  },
});

const downloadExportRoute = createRoute({
  method: 'get', path: '/export/{exportId}/download', tags: ['Exports'],
  summary: 'Download export file',
  request: {
    params: jobIdParam.extend({
      exportId: z.string().openapi({ param: { name: 'exportId', in: 'path' } }),
    }),
  },
  responses: {
    200: { description: 'File download', content: { 'application/octet-stream': { schema: z.string() } } },
    404: jsonContent(errorResponseSchema, 'Export not found'),
    409: jsonContent(errorResponseSchema, 'Export not ready'),
  },
});

const getDocumentationRoute = createRoute({
  method: 'get', path: '/documentation', tags: ['Exports'],
  summary: 'Get data dictionary / documentation',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(z.object({ data: z.record(z.unknown()) }), 'Data documentation'),
    404: jsonContent(errorResponseSchema, 'Schema not found'),
  },
});

export function exportRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(triggerExportRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const body = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.create({
      jobId, tenantId, format: body.format, includeProvenance: body.includeProvenance,
    });

    await deps.exportQueue.add('export', {
      exportId: exportRecord.id, jobId, tenantId,
      format: body.format, includeProvenance: body.includeProvenance,
    }, { attempts: 1, removeOnComplete: true, removeOnFail: true });

    return c.json({ data: exportRecord }, 202);
  });

  router.openapi(getExportRoute, async (c) => {
    const { exportId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);

    return c.json({ data: exportRecord });
  });

  router.openapi(downloadExportRoute, async (c) => {
    const { exportId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);
    if (exportRecord.status !== 'completed' || !exportRecord.contentRef) {
      throw new ConflictError('Export is not yet completed');
    }

    const content = await deps.contentStore.retrieve(exportRecord.contentRef);
    const contentType = exportRecord.format === 'csv' ? 'text/csv' : 'application/json';
    const jobShort = exportRecord.jobId.slice(0, 8);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `spatula-${jobShort}-${date}.${exportRecord.format}`;

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(exportRecord.fileSize ? { 'Content-Length': String(exportRecord.fileSize) } : {}),
      },
    });
  });

  router.openapi(getDocumentationRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) throw new NotFoundError('Schema', jobId);
    const schema = schemaRow.definition as SchemaDefinition;

    const [entities, totalCount] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, { limit: 1000 }),
      deps.entityRepo.countByJob(jobId, tenantId),
    ]);

    const documentation = generateDocumentation(schema, entities as unknown as Entity[], jobId);
    return c.json({ data: { ...documentation, entityCount: totalCount } });
  });

  return router;
}
```

- [ ] **Step 9: Convert tenants.ts**

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { createTenantSchema, updateTenantSchema } from '../schemas/tenant.js';
import { tenantResponseSchema, errorResponseSchema, dataResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

const createTenantRoute = createRoute({
  method: 'post', path: '/', tags: ['Tenants'],
  summary: 'Create a new tenant',
  request: {
    body: { content: { 'application/json': { schema: createTenantSchema } }, required: true },
  },
  responses: {
    201: jsonContent(dataResponse(tenantResponseSchema), 'Tenant created'),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const getTenantRoute = createRoute({
  method: 'get', path: '/{id}', tags: ['Tenants'],
  summary: 'Get tenant by ID',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(tenantResponseSchema), 'Tenant details'),
    404: jsonContent(errorResponseSchema, 'Tenant not found'),
  },
});

const updateTenantRoute = createRoute({
  method: 'patch', path: '/{id}', tags: ['Tenants'],
  summary: 'Update tenant name or config',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: updateTenantSchema } }, required: true },
  },
  responses: {
    200: jsonContent(dataResponse(tenantResponseSchema), 'Updated tenant'),
    404: jsonContent(errorResponseSchema, 'Tenant not found'),
  },
});

export function tenantRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(createTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const body = c.req.valid('json');
    const tenant = await deps.tenantRepo.create(body);
    return c.json({ data: tenant }, 201);
  });

  router.openapi(getTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const { id } = c.req.valid('param');
    const tenant = await deps.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundError('Tenant', id);

    return c.json({ data: tenant });
  });

  router.openapi(updateTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const tenant = await deps.tenantRepo.update(id, body);
    return c.json({ data: tenant });
  });

  return router;
}
```

- [ ] **Step 10: Verify build + all tests pass**

Run: `cd apps/api && pnpm build && pnpm test -- --run`
Expected: PASS

- [ ] **Step 11: Remove unused validation middleware (optional cleanup)**

The `validateBody` and `validateQuery` functions in `apps/api/src/middleware/validate.ts` are no longer used by any route after full OpenAPI conversion. They can be removed or kept as utilities. If removing:

1. Delete the middleware functions from `validate.ts` (or delete the file)
2. Remove any remaining imports of `validateBody`/`validateQuery` from route files
3. Verify build: `pnpm build`

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/routes/ apps/api/src/schemas/ apps/api/src/middleware/
git commit -m "feat(api): convert all routes to @hono/zod-openapi with full OpenAPI 3.1 spec generation"
```

---

## Post-Implementation Verification

After all tasks are complete, verify the full integration:

1. **Build all packages:** `pnpm build`
2. **Run all tests:** `pnpm test`
3. **Start the API server** and verify:
   - `GET /api/openapi.json` returns valid OpenAPI 3.1 spec
   - `GET /api/docs` renders Swagger UI
   - All endpoints listed in Swagger UI with correct schemas
   - `PATCH /api/v1/jobs/:id` works with each action
   - `DELETE /api/v1/jobs/:id` cascades correctly
   - `POST /api/v1/tenants` creates tenant without `x-tenant-id`
   - Requests with invalid `x-tenant-id` return 404 (when tenantRepo configured)
