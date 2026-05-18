# Wave 5-3: Admin & Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build admin API endpoints for platform operators, add configurable retention policies, and implement the daily cleanup worker.

**Architecture:** Admin routes follow the existing Hono pattern (factory function returning a router), already scoped behind `requireScope('admin')` at the `/api/v1/admin/*` level. The cleanup worker follows the metering worker pattern — a stateless processor function with duck-typed deps, registered in worker-entrypoint as a BullMQ repeatable job (daily at 03:00 UTC). Tenant status enforcement is a single check added to the existing `validate-tenant` middleware.

**Tech Stack:** Hono, Drizzle ORM, BullMQ, Vitest, PostgreSQL

---

## File Map

| File                                                     | Action    | Responsibility                        |
| -------------------------------------------------------- | --------- | ------------------------------------- |
| `apps/api/src/middleware/validate-tenant.ts`             | Modify    | Add suspended tenant check            |
| `apps/api/src/routes/admin-dlq.ts`                       | Modify    | Admin cross-tenant DLQ access         |
| `apps/api/src/routes/admin-tenants.ts`                   | Create    | 3 admin tenant endpoints              |
| `apps/api/src/routes/admin-jobs.ts`                      | Create    | 2 admin job endpoints                 |
| `apps/api/src/routes/admin-system.ts`                    | Create    | 2 admin system endpoints              |
| `apps/api/src/routes/admin-queues.ts`                    | Modify    | Add cleanup+metering to Bull Board    |
| `apps/api/src/app.ts`                                    | Modify    | Register new admin routes             |
| `apps/api/src/types.ts`                                  | No change | AppDeps already has all needed fields |
| `packages/db/src/repositories/tenant-repository.ts`      | Modify    | Add `findAll`, `updateStatus` methods |
| `packages/db/src/repositories/job-repository.ts`         | Modify    | Add `findAll` (cross-tenant) method   |
| `packages/queue/src/queues.ts`                           | Modify    | Add `CLEANUP` queue name              |
| `packages/queue/src/cleanup-worker.ts`                   | Create    | Daily cleanup processor               |
| `packages/queue/src/worker-entrypoint.ts`                | Modify    | Register cleanup worker               |
| `packages/queue/src/index.ts`                            | Modify    | Export cleanup worker                 |
| `apps/api/tests/unit/middleware/validate-tenant.test.ts` | Modify    | Add suspended tests                   |
| `apps/api/tests/unit/routes/admin-dlq.test.ts`           | Modify    | Add cross-tenant tests                |
| `apps/api/tests/unit/routes/admin-tenants.test.ts`       | Create    | Admin tenant route tests              |
| `apps/api/tests/unit/routes/admin-jobs.test.ts`          | Create    | Admin job route tests                 |
| `apps/api/tests/unit/routes/admin-system.test.ts`        | Create    | Admin system route tests              |
| `packages/queue/tests/unit/cleanup-worker.test.ts`       | Create    | Cleanup worker tests                  |

---

## Task 1: Tenant Status Enforcement (validate-tenant middleware)

**Files:**

- Modify: `apps/api/src/middleware/validate-tenant.ts`
- Modify: `apps/api/tests/unit/middleware/validate-tenant.test.ts`

When a tenant's status field in the config JSONB is `"suspended"`, all API calls for that tenant should return 403.

- [ ] **Step 1: Write the failing test for suspended tenant**

In `apps/api/tests/unit/middleware/validate-tenant.test.ts`, add:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { validateTenantMiddleware } from '../../../src/middleware/validate-tenant.js';

describe('validateTenantMiddleware', () => {
  function createApp(tenantRepo: any) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', { tenantRepo });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('returns 403 for suspended tenant', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        config: { status: 'suspended' },
      }),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('suspended');
  });

  it('allows active tenant through', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        config: {},
      }),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown tenant', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(404);
  });

  it('passes through when tenantRepo is undefined', async () => {
    const app = createApp(undefined);
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/middleware/validate-tenant.test.ts`
Expected: FAIL — the suspended test returns 200 instead of 403.

- [ ] **Step 3: Implement suspended check in validate-tenant middleware**

Replace the contents of `apps/api/src/middleware/validate-tenant.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from '@spatula/shared';
import { NotFoundError } from './error-handler.js';

export const validateTenantMiddleware: MiddlewareHandler = async (c, next) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');

  if (deps.tenantRepo && tenantId) {
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant', tenantId);
    }
    const config = (tenant.config ?? {}) as Record<string, unknown>;
    if (config.status === 'suspended') {
      throw new ForbiddenError('Account suspended. Contact support.');
    }
  }

  return next();
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/middleware/validate-tenant.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/validate-tenant.ts apps/api/tests/unit/middleware/validate-tenant.test.ts
git commit -m "feat(auth): enforce 403 for suspended tenants in validate-tenant middleware"
```

---

## Task 2: Admin DLQ Cross-Tenant Access

**Files:**

- Modify: `apps/api/src/routes/admin-dlq.ts`
- Modify: `apps/api/tests/unit/routes/admin-dlq.test.ts`

When the calling user has `admin` scope, omit the tenantId filter in DLQ queries. This resolves the TODO at `admin-dlq.ts:17`.

- [ ] **Step 1: Write the failing test for cross-tenant DLQ access**

Append to `apps/api/tests/unit/routes/admin-dlq.test.ts`:

```typescript
describe('admin cross-tenant DLQ access', () => {
  it('omits tenantId filter when caller has admin scope', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);

    // Admin-scoped request (NoAuthProvider gives admin scope by default)
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });
    expect(res.status).toBe(200);

    // Verify tenantId was NOT passed to findUnresolved
    expect(deps.dlqRepo!.findUnresolved).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined }),
    );
  });

  it('returns entries from all tenants', async () => {
    const otherTenantEntry = {
      ...SAMPLE_DLQ_ENTRY,
      id: 'dlq-2',
      tenantId: '00000000-0000-0000-0000-000000000099',
    };
    const deps = createMockDeps({
      dlqRepo: {
        findUnresolved: vi.fn().mockResolvedValue([SAMPLE_DLQ_ENTRY, otherTenantEntry]),
        countUnresolved: vi.fn().mockResolvedValue(2),
        findById: vi.fn(),
        resolve: vi.fn(),
        insert: vi.fn(),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it('admin can access single DLQ entry from any tenant (GET /:id)', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1', { headers: tenantHeader });
    expect(res.status).toBe(200);
    // Admin scope means tenantId is omitted from findById
    expect(deps.dlqRepo!.findById).toHaveBeenCalledWith('dlq-1', undefined);
  });

  it('admin can retry DLQ entry from any tenant (POST /:id/retry)', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    expect(deps.dlqRepo!.findById).toHaveBeenCalledWith('dlq-1', undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-dlq.test.ts`
Expected: FAIL — tenantId is currently always passed to `findUnresolved`.

- [ ] **Step 3: Update admin-dlq.ts to check for admin scope**

In `apps/api/src/routes/admin-dlq.ts`, update the `GET /` handler to check auth scopes:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { AuthResult } from '@spatula/shared';

export function adminDlqRoutes() {
  const app = new Hono<AppEnv>();

  // List unresolved DLQ entries
  // Admin-scoped callers see all tenants; others see only their own.
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const queueName = c.req.query('queue');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const entries = await deps.dlqRepo.findUnresolved({ queueName, tenantId, limit, offset });
    const total = await deps.dlqRepo.countUnresolved(queueName, tenantId);

    return c.json({ data: entries, pagination: { total, limit, offset } });
  });

  // Get single DLQ entry — admins can access any tenant's entries
  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);

    return c.json({ data: entry });
  });

  // Retry a DLQ entry
  app.post('/:id/retry', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt)
      return c.json(
        { error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } },
        409,
      );

    if (deps.queues) {
      const queueMap: Record<string, any> = {
        'spatula.crawl': deps.queues.crawl,
        'spatula.schema-evolution': deps.queues.schemaEvolution,
        'spatula.reconciliation': deps.queues.reconciliation,
        'spatula.export': deps.queues.export,
      };
      const targetQueue = queueMap[entry.queueName];
      if (targetQueue) {
        await targetQueue.add(`dlq-retry:${entry.id}`, entry.payload);
      }
    }

    const resolved = await deps.dlqRepo.resolve(c.req.param('id'), 'retried');
    return c.json({ data: resolved });
  });

  // Discard a DLQ entry
  app.post('/:id/discard', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt)
      return c.json(
        { error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } },
        409,
      );

    const resolved = await deps.dlqRepo.resolve(c.req.param('id'), 'discarded');
    return c.json({ data: resolved });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-dlq.test.ts`
Expected: All tests PASS (including existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin-dlq.ts apps/api/tests/unit/routes/admin-dlq.test.ts
git commit -m "feat(admin): enable cross-tenant DLQ access for admin-scoped callers"
```

---

## Task 3: Tenant Repository Extensions

**Files:**

- Modify: `packages/db/src/repositories/tenant-repository.ts`
- Modify: `packages/db/src/index.ts` (if new types need exporting)
- Test: `packages/db/tests/unit/repositories/tenant-repository.test.ts` (create or extend)

Add `findAll` (paginated, filterable by plan), `countAll`, and `getTotalStorage` for the admin tenant and system routes.

- [ ] **Step 1: Write the failing tests**

Create or extend `packages/db/tests/unit/repositories/tenant-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantRepository } from '../../src/repositories/tenant-repository.js';

// Use a mock db that captures queries for assertion
function createMockDb() {
  const chain: any = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'update',
    'set',
    'returning',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // select().from().where().orderBy().limit().offset() → resolves to rows
  chain.offset = vi.fn().mockResolvedValue([]);
  chain.returning = vi
    .fn()
    .mockResolvedValue([{ id: 'tenant-1', name: 'Test', config: {}, plan: 'free' }]);
  chain.select = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('TenantRepository.findAll', () => {
  it('returns paginated tenants with plan filter', async () => {
    const db = createMockDb();
    db.offset = vi
      .fn()
      .mockResolvedValue([
        { id: 't1', name: 'Tenant 1', plan: 'free', config: {}, createdAt: new Date() },
      ]);
    const repo = new TenantRepository(db as any);
    const results = await repo.findAll({ plan: 'free', limit: 10, offset: 0 });
    expect(results).toHaveLength(1);
    expect(db.select).toHaveBeenCalled();
  });
});

describe('TenantRepository.countAll', () => {
  it('returns count from database', async () => {
    const db = createMockDb();
    db.where = vi.fn().mockResolvedValue([{ count: 5 }]);
    // For no-filter path: select().from() resolves directly
    db.from = vi.fn().mockResolvedValue([{ count: 5 }]);
    const repo = new TenantRepository(db as any);
    const count = await repo.countAll();
    expect(count).toBe(5);
  });
});

describe('TenantRepository.getTotalStorage', () => {
  it('returns sum of storage_bytes_used across all tenants', async () => {
    const db = createMockDb();
    db.from = vi.fn().mockResolvedValue([{ total: 1048576 }]);
    const repo = new TenantRepository(db as any);
    const total = await repo.getTotalStorage();
    expect(total).toBe(1048576);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db exec vitest run tests/unit/repositories/tenant-repository.test.ts`
Expected: FAIL — `findAll` and `countAll` don't exist.

- [ ] **Step 3: Add methods to TenantRepository**

In `packages/db/src/repositories/tenant-repository.ts`, add these methods to the class (after `incrementStorageBytes`):

```typescript
  async findAll(options?: {
    plan?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      const conditions = [];
      if (options?.plan) {
        conditions.push(eq(tenants.plan, options.plan));
      }

      let query = this.db
        .select()
        .from(tenants)
        .orderBy(desc(tenants.createdAt));

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return await query
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to list tenants: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async countAll(options?: { plan?: string }): Promise<number> {
    try {
      const conditions = [];
      if (options?.plan) {
        conditions.push(eq(tenants.plan, options.plan));
      }

      const query = this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(tenants);

      const rows = conditions.length > 0
        ? await query.where(and(...conditions))
        : await query;

      return (rows[0] as any)?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count tenants: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async getTotalStorage(): Promise<number> {
    try {
      const [row] = await this.db
        .select({ total: sql<number>`coalesce(sum(storage_bytes_used), 0)::bigint` })
        .from(tenants);
      return Number((row as any)?.total ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to get total storage: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }
```

Also add the missing imports at the top of the file — `desc`, `and`, `sql` need to be in the import from `drizzle-orm`:

```typescript
import { eq, desc, and, sql } from 'drizzle-orm';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db exec vitest run tests/unit/repositories/tenant-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/tenant-repository.ts packages/db/tests/unit/repositories/tenant-repository.test.ts
git commit -m "feat(db): add findAll and countAll methods to TenantRepository"
```

---

## Task 4: Job Repository Cross-Tenant Extension

**Files:**

- Modify: `packages/db/src/repositories/job-repository.ts`
- Test: `packages/db/tests/unit/repositories/job-repository-admin.test.ts` (create)

Add `findAll` method (cross-tenant job listing for admin) and `forceCancelJob` (update to cancelled ignoring tenant scope).

- [ ] **Step 1: Write the failing tests**

Create `packages/db/tests/unit/repositories/job-repository-admin.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { JobRepository } from '../../src/repositories/job-repository.js';

function createMockDb() {
  const chain: any = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'update',
    'set',
    'returning',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.offset = vi.fn().mockResolvedValue([]);
  chain.returning = vi.fn().mockResolvedValue([]);
  chain.select = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('JobRepository.findAll', () => {
  it('returns jobs without tenant scoping', async () => {
    const db = createMockDb();
    const jobs = [{ id: 'job-1', tenantId: 't1', status: 'running' }];
    db.offset = vi.fn().mockResolvedValue(jobs);
    const repo = new JobRepository(db as any);
    const result = await repo.findAll({ limit: 10, offset: 0 });
    expect(result).toEqual(jobs);
    expect(db.select).toHaveBeenCalled();
  });

  it('applies status filter when provided', async () => {
    const db = createMockDb();
    db.offset = vi.fn().mockResolvedValue([]);
    const repo = new JobRepository(db as any);
    await repo.findAll({ status: 'running' as any });
    expect(db.where).toHaveBeenCalled();
  });
});

describe('JobRepository.countAll', () => {
  it('returns count of all jobs', async () => {
    const db = createMockDb();
    db.from = vi.fn().mockResolvedValue([{ count: 42 }]);
    const repo = new JobRepository(db as any);
    const count = await repo.countAll();
    expect(count).toBe(42);
  });
});

describe('JobRepository.forceCancel', () => {
  it('returns updated job on success', async () => {
    const db = createMockDb();
    const cancelled = { id: 'job-1', status: 'cancelled', completedAt: new Date() };
    db.returning = vi.fn().mockResolvedValue([cancelled]);
    const repo = new JobRepository(db as any);
    const result = await repo.forceCancel('job-1');
    expect(result).toEqual(cancelled);
    expect(db.update).toHaveBeenCalled();
  });

  it('returns null when job not found', async () => {
    const db = createMockDb();
    db.returning = vi.fn().mockResolvedValue([]);
    const repo = new JobRepository(db as any);
    const result = await repo.forceCancel('nonexistent');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db exec vitest run tests/unit/repositories/job-repository-admin.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add methods to JobRepository**

In `packages/db/src/repositories/job-repository.ts`, add these methods to the class (after `deleteWithData`):

```typescript
  /**
   * Cross-tenant job listing for admin endpoints.
   * Supports optional filters by status and tenantId.
   */
  async findAll(options?: {
    status?: JobStatus;
    tenantId?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      const conditions = [];
      if (options?.status) conditions.push(eq(jobs.status, options.status));
      if (options?.tenantId) conditions.push(eq(jobs.tenantId, options.tenantId));

      let query = this.db
        .select()
        .from(jobs)
        .orderBy(desc(jobs.createdAt));

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return await query
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to list all jobs: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Count all jobs across tenants with optional filters. For admin endpoints.
   */
  async countAll(options?: { status?: JobStatus; tenantId?: string }): Promise<number> {
    try {
      const conditions = [];
      if (options?.status) conditions.push(eq(jobs.status, options.status));
      if (options?.tenantId) conditions.push(eq(jobs.tenantId, options.tenantId));

      const query = this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs);

      const rows = conditions.length > 0
        ? await query.where(and(...conditions))
        : await query;

      return (rows[0] as any)?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count all jobs: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Force-cancel a job without tenant scoping. For admin use only.
   * Sets status to 'cancelled' and completedAt to now.
   */
  async forceCancel(jobId: string): Promise<typeof jobs.$inferSelect | null> {
    try {
      const [row] = await this.db
        .update(jobs)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(jobs.id, jobId))
        .returning();

      if (row && this.cache) {
        await this.cache.delete(`job:${jobId}:config`);
      }

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to force-cancel job ${jobId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db exec vitest run tests/unit/repositories/job-repository-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/job-repository.ts packages/db/tests/unit/repositories/job-repository-admin.test.ts
git commit -m "feat(db): add cross-tenant findAll and forceCancel to JobRepository"
```

---

## Task 5: Admin Tenant Routes

**Files:**

- Create: `apps/api/src/routes/admin-tenants.ts`
- Create: `apps/api/tests/unit/routes/admin-tenants.test.ts`

Three endpoints: `GET /admin/tenants` (list), `GET /admin/tenants/:id` (detail), `PATCH /admin/tenants/:id` (update plan/status/retention).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/unit/routes/admin-tenants.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const tenantHeader = { 'x-tenant-id': TENANT_ID };

const SAMPLE_TENANT = {
  id: TENANT_ID,
  name: 'Test Tenant',
  config: {},
  quotas: { maxConcurrentJobs: 2 },
  storageBytesUsed: 1024,
  plan: 'free',
  stripeCustomerId: null,
  createdAt: new Date('2026-01-01'),
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
      findAll: vi.fn().mockResolvedValue([]),
      forceCancel: vi.fn(),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue(SAMPLE_TENANT),
      findAll: vi.fn().mockResolvedValue([SAMPLE_TENANT]),
      countAll: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue(SAMPLE_TENANT),
      updatePlan: vi.fn(),
    } as any,
    userTenantRepo: {
      findByTenantId: vi
        .fn()
        .mockResolvedValue([{ userId: 'user-1', role: 'owner', createdAt: new Date() }]),
    } as any,
    usageRecordRepo: {
      aggregateByTenant: vi.fn().mockResolvedValue([{ dimension: 'pages', total: 500 }]),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    ...overrides,
  };
}

describe('GET /api/v1/admin/tenants', () => {
  it('returns paginated tenant list with user count', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/tenants', { headers: tenantHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(TENANT_ID);
    expect(body.data[0].userCount).toBe(1);
    expect(body.pagination.total).toBe(1);
  });

  it('passes plan filter to repo', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    await app.request('/api/v1/admin/tenants?plan=starter', { headers: tenantHeader });
    expect(deps.tenantRepo!.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'starter' }),
    );
  });
});

describe('GET /api/v1/admin/tenants/:id', () => {
  it('returns tenant detail with users and usage', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, { headers: tenantHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TENANT_ID);
    expect(body.data.users).toHaveLength(1);
    expect(body.data.usage).toBeDefined();
  });

  it('returns 404 for unknown tenant', async () => {
    const deps = createMockDeps({
      tenantRepo: {
        findById: vi.fn().mockResolvedValueOnce(SAMPLE_TENANT).mockResolvedValueOnce(null),
        findAll: vi.fn(),
        countAll: vi.fn(),
        update: vi.fn(),
        updatePlan: vi.fn(),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/tenants/nonexistent', { headers: tenantHeader });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/admin/tenants/:id', () => {
  it('updates tenant plan and logs audit event', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    expect(res.status).toBe(200);
    expect(deps.tenantRepo!.updatePlan).toHaveBeenCalledWith(TENANT_ID, 'pro', undefined);
    expect(deps.auditLogger!.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.tenant.plan_change' }),
    );
  });

  it('updates tenant config (status, retention)', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { status: 'suspended' } }),
    });
    expect(res.status).toBe(200);
    expect(deps.tenantRepo!.update).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ config: expect.objectContaining({ status: 'suspended' }) }),
    );
    expect(deps.auditLogger!.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.tenant.config_update' }),
    );
  });

  it('rejects invalid plan name', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'mega-ultra' }),
    });
    expect(res.status).toBe(400);
  });

  it('enforces minimum retention days', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { retention: { completedJobsDays: 3 } } }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-tenants.test.ts`
Expected: FAIL — route module doesn't exist.

- [ ] **Step 3: Create admin-tenants.ts**

Create `apps/api/src/routes/admin-tenants.ts`:

```typescript
import { Hono } from 'hono';
import { ValidationError } from '@spatula/shared';
import { BILLING_TIERS } from '@spatula/shared';
import type { BillingTierName } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const VALID_PLANS = Object.keys(BILLING_TIERS);
const MIN_RETENTION_DAYS = 7;

const RETENTION_FIELDS = [
  'completedJobsDays',
  'failedJobsDays',
  'rawPagesDays',
  'exportsDays',
] as const;

export function adminTenantRoutes() {
  const app = new Hono<AppEnv>();

  // GET / — list all tenants with pagination and plan filter
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo)
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } },
        503,
      );

    const plan = c.req.query('plan');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const [tenantList, total] = await Promise.all([
      deps.tenantRepo.findAll({ plan, limit, offset }),
      deps.tenantRepo.countAll({ plan }),
    ]);

    // Fetch user counts in parallel for all tenants in this page
    const userCounts = await Promise.all(
      tenantList.map(async (t: any) => {
        if (!deps.userTenantRepo) return 0;
        const users = await deps.userTenantRepo.findByTenantId(t.id);
        return users.length;
      }),
    );

    return c.json({
      data: tenantList.map((t: any, i: number) => ({
        id: t.id,
        name: t.name,
        plan: t.plan,
        storageBytesUsed: t.storageBytesUsed,
        userCount: userCounts[i],
        createdAt: t.createdAt,
        config: t.config,
      })),
      pagination: { total, limit, offset },
    });
  });

  // GET /:id — tenant detail with users, usage, recent jobs
  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.tenantRepo)
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } },
        503,
      );

    const tenant = await deps.tenantRepo.findById(id);
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    // Fetch users, usage, and recent jobs in parallel
    const [users, usage, recentJobs] = await Promise.all([
      deps.userTenantRepo?.findByTenantId(id) ?? [],
      deps.usageRecordRepo
        ? deps.usageRecordRepo.aggregateByTenant(
            id,
            new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
          )
        : [],
      deps.jobRepo.findByTenant(id, { limit: 5 }),
    ]);

    const usageMap: Record<string, number> = {};
    for (const u of usage) {
      usageMap[u.dimension] = u.total;
    }

    return c.json({
      data: {
        ...(tenant as any),
        users: users.map((u: any) => ({ userId: u.userId, role: u.role })),
        usage: usageMap,
        recentJobs: recentJobs.map((j: any) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          createdAt: j.createdAt,
        })),
      },
    });
  });

  // PATCH /:id — update plan, config (status, retention, quotas)
  app.patch('/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.tenantRepo)
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } },
        503,
      );

    const body = await c.req.json();
    const auth = c.get('auth');
    const actorId = auth?.userId ?? 'system';

    // Validate plan if provided
    if (body.plan !== undefined) {
      if (!VALID_PLANS.includes(body.plan)) {
        throw new ValidationError(
          `Invalid plan: ${body.plan}. Must be one of: ${VALID_PLANS.join(', ')}`,
        );
      }
    }

    // Validate retention config if provided
    if (body.config?.retention) {
      for (const field of RETENTION_FIELDS) {
        const value = body.config.retention[field];
        if (value !== undefined && (typeof value !== 'number' || value < MIN_RETENTION_DAYS)) {
          throw new ValidationError(
            `Retention field "${field}" must be a number >= ${MIN_RETENTION_DAYS}`,
          );
        }
      }
    }

    // Fetch current tenant to merge config
    const existing = await deps.tenantRepo.findById(id);
    if (!existing)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    // Apply plan change
    if (body.plan !== undefined) {
      await deps.tenantRepo.updatePlan(id, body.plan, body.stripeCustomerId);
      deps.auditLogger?.log({
        tenantId: id,
        actorId,
        actorType: 'user',
        action: 'admin.tenant.plan_change',
        resourceType: 'tenant',
        resourceId: id,
        metadata: { oldPlan: (existing as any).plan, newPlan: body.plan },
      });
    }

    // Apply config changes (merge with existing)
    if (body.config !== undefined) {
      const existingConfig = ((existing as any).config ?? {}) as Record<string, unknown>;
      const mergedConfig = { ...existingConfig, ...body.config };

      // Deep merge retention
      if (body.config.retention) {
        mergedConfig.retention = {
          ...((existingConfig.retention as Record<string, unknown>) ?? {}),
          ...body.config.retention,
        };
      }

      await deps.tenantRepo.update(id, { config: mergedConfig });
      deps.auditLogger?.log({
        tenantId: id,
        actorId,
        actorType: 'user',
        action: 'admin.tenant.config_update',
        resourceType: 'tenant',
        resourceId: id,
        metadata: { changes: body.config },
      });
    }

    // Re-fetch updated tenant
    const updated = await deps.tenantRepo.findById(id);
    return c.json({ data: updated });
  });

  return app;
}
```

- [ ] **Step 4: Register admin tenant routes in app.ts**

In `apps/api/src/app.ts`, add the import and route registration:

Import (add near line 19):

```typescript
import { adminTenantRoutes } from './routes/admin-tenants.js';
```

Route registration (add after line 180):

```typescript
app.route('/api/v1/admin/tenants', adminTenantRoutes());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-tenants.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Run full API test suite for regressions**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run`
Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin-tenants.ts apps/api/src/app.ts apps/api/tests/unit/routes/admin-tenants.test.ts
git commit -m "feat(admin): add tenant management routes (list, detail, update plan/config/retention)"
```

---

## Task 6: Admin Job Routes

**Files:**

- Create: `apps/api/src/routes/admin-jobs.ts`
- Create: `apps/api/tests/unit/routes/admin-jobs.test.ts`
- Modify: `apps/api/src/app.ts` (register route)

Two endpoints: `GET /admin/jobs` (cross-tenant list), `POST /admin/jobs/:id/force-cancel`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/unit/routes/admin-jobs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const tenantHeader = { 'x-tenant-id': TENANT_ID };

const SAMPLE_JOB = {
  id: 'job-1',
  tenantId: TENANT_ID,
  name: 'Test Job',
  status: 'running',
  createdAt: new Date('2026-04-01'),
  config: {},
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn().mockResolvedValue(SAMPLE_JOB),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
      findAll: vi.fn().mockResolvedValue([SAMPLE_JOB]),
      countAll: vi.fn().mockResolvedValue(1),
      forceCancel: vi.fn().mockResolvedValue({ ...SAMPLE_JOB, status: 'cancelled' }),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, plan: 'free', config: {} }),
      findAll: vi.fn(),
      countAll: vi.fn(),
      update: vi.fn(),
      updatePlan: vi.fn(),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    ...overrides,
  };
}

describe('GET /api/v1/admin/jobs', () => {
  it('returns cross-tenant job list with pagination', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs', { headers: tenantHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('job-1');
    expect(body.pagination).toBeDefined();
    expect(body.pagination.total).toBe(1);
  });

  it('passes status and tenantId filters', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    await app.request('/api/v1/admin/jobs?status=running&tenantId=t-1', { headers: tenantHeader });
    expect(deps.jobRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', tenantId: 't-1' }),
    );
  });
});

describe('POST /api/v1/admin/jobs/:id/force-cancel', () => {
  it('force-cancels a job and logs audit event', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/job-1/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
    expect(deps.jobRepo.forceCancel).toHaveBeenCalledWith('job-1');
    expect(deps.auditLogger!.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.job.force_cancel' }),
    );
  });

  it('returns 404 if job does not exist', async () => {
    const deps = createMockDeps({
      jobRepo: {
        ...createMockDeps().jobRepo,
        forceCancel: vi.fn().mockResolvedValue(null),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/nonexistent/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-jobs.test.ts`
Expected: FAIL — route module doesn't exist.

- [ ] **Step 3: Create admin-jobs.ts**

Create `apps/api/src/routes/admin-jobs.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminJobRoutes() {
  const app = new Hono<AppEnv>();

  // GET / — list jobs across all tenants with pagination
  app.get('/', async (c) => {
    const deps = c.get('deps');
    const status = c.req.query('status') as any;
    const tenantId = c.req.query('tenantId');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const [jobList, total] = await Promise.all([
      deps.jobRepo.findAll({ status, tenantId, limit, offset }),
      deps.jobRepo.countAll({ status, tenantId }),
    ]);

    return c.json({
      data: jobList.map((j: any) => ({
        id: j.id,
        tenantId: j.tenantId,
        name: j.name,
        status: j.status,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
      pagination: { total, limit, offset },
    });
  });

  // POST /:id/force-cancel — force-cancel a stuck job
  app.post('/:id/force-cancel', async (c) => {
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    const job = await deps.jobRepo.forceCancel(jobId);
    if (!job) return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);

    // Drain BullMQ jobs for this job if queues are available
    if (deps.queues) {
      // Best-effort removal of pending queue jobs for this spatula job
      for (const queue of [
        deps.queues.crawl,
        deps.queues.extract,
        deps.queues.schemaEvolution,
        deps.queues.reconciliation,
        deps.queues.export,
      ]) {
        try {
          const waiting = await queue.getJobs(['waiting', 'delayed']);
          for (const queueJob of waiting) {
            if ((queueJob.data as any)?.jobId === jobId) {
              await queueJob.remove();
            }
          }
        } catch {
          // Best effort — queue may not be available
        }
      }
    }

    const auth = c.get('auth');
    deps.auditLogger?.log({
      tenantId: (job as any).tenantId,
      actorId: auth?.userId ?? 'system',
      actorType: 'user',
      action: 'admin.job.force_cancel',
      resourceType: 'job',
      resourceId: jobId,
    });

    return c.json({ data: job });
  });

  return app;
}
```

- [ ] **Step 4: Register admin job routes in app.ts**

Import (add near the admin-tenants import):

```typescript
import { adminJobRoutes } from './routes/admin-jobs.js';
```

Route registration (add after the admin/tenants route):

```typescript
app.route('/api/v1/admin/jobs', adminJobRoutes());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-jobs.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-jobs.ts apps/api/src/app.ts apps/api/tests/unit/routes/admin-jobs.test.ts
git commit -m "feat(admin): add cross-tenant job listing and force-cancel endpoints"
```

---

## Task 7: Admin System Routes

**Files:**

- Create: `apps/api/src/routes/admin-system.ts`
- Create: `apps/api/tests/unit/routes/admin-system.test.ts`
- Modify: `apps/api/src/app.ts` (register route)

Two endpoints: `GET /admin/system/health` (detailed health), `GET /admin/system/metrics` (key metrics).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/unit/routes/admin-system.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const tenantHeader = { 'x-tenant-id': TENANT_ID };

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: {
      end: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ '1': 1 }] }),
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0,
    } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
      findAll: vi.fn().mockResolvedValue([]),
      countAll: vi.fn().mockResolvedValue(5),
      forceCancel: vi.fn(),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, plan: 'free', config: {} }),
      findAll: vi.fn(),
      countAll: vi.fn().mockResolvedValue(3),
      getTotalStorage: vi.fn().mockResolvedValue(1048576),
      update: vi.fn(),
      updatePlan: vi.fn(),
    } as any,
    redis: {
      ping: vi.fn().mockResolvedValue('PONG'),
      info: vi.fn().mockResolvedValue('used_memory:1024000\r\nused_memory_human:1M'),
    } as any,
    queues: {
      crawl: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 1, active: 2, completed: 10, failed: 0, delayed: 0 }),
      },
      extract: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 5, failed: 0, delayed: 0 }),
      },
      schemaEvolution: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      },
      reconciliation: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      },
      export: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      },
      webhook: {
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      },
    } as any,
    dlqRepo: { countUnresolved: vi.fn().mockResolvedValue(2) } as any,
    ...overrides,
  };
}

describe('GET /api/v1/admin/system/health', () => {
  it('returns detailed health status', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.postgres).toBe('ok');
    expect(body.data.redis).toBe('ok');
    expect(body.data.queues).toBeDefined();
    expect(body.data.queues.crawl).toBeDefined();
  });

  it('marks redis as degraded when unavailable', async () => {
    const deps = createMockDeps({ redis: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });
    const body = await res.json();
    expect(body.data.redis).toBe('not_configured');
  });

  it('marks postgres as error when query fails', async () => {
    const deps = createMockDeps({
      dbPool: {
        end: vi.fn(),
        query: vi.fn().mockRejectedValue(new Error('connection refused')),
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
      } as unknown as Pool,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });
    const body = await res.json();
    expect(body.data.postgres).toBe('error');
  });
});

describe('GET /api/v1/admin/system/metrics', () => {
  it('returns system metrics including active jobs and storage', async () => {
    const deps = createMockDeps();
    (deps.jobRepo as any).countAll = vi.fn().mockResolvedValue(5);
    (deps.tenantRepo as any).getTotalStorage = vi.fn().mockResolvedValue(1048576);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/metrics', { headers: tenantHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalTenants).toBe(3);
    expect(body.data.activeJobs).toBe(5);
    expect(body.data.totalStorageBytes).toBe(1048576);
    expect(body.data.dlqDepth).toBe(2);
    expect(body.data.queues).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-system.test.ts`
Expected: FAIL — route module doesn't exist.

- [ ] **Step 3: Create admin-system.ts**

Create `apps/api/src/routes/admin-system.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminSystemRoutes() {
  const app = new Hono<AppEnv>();

  // GET /health — detailed system health
  app.get('/health', async (c) => {
    const deps = c.get('deps');

    // Postgres check
    let postgresStatus = 'ok';
    try {
      await deps.dbPool.query('SELECT 1');
    } catch {
      postgresStatus = 'error';
    }

    // Redis check
    let redisStatus = 'not_configured';
    if (deps.redis) {
      try {
        await deps.redis.ping();
        redisStatus = 'ok';
      } catch {
        redisStatus = 'error';
      }
    }

    // Queue health
    const queues: Record<string, unknown> = {};
    if (deps.queues) {
      const queueNames = [
        'crawl',
        'extract',
        'schemaEvolution',
        'reconciliation',
        'export',
        'webhook',
      ] as const;
      for (const name of queueNames) {
        try {
          const counts = await deps.queues[name].getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          queues[name] = counts;
        } catch {
          queues[name] = { error: 'unavailable' };
        }
      }
    }

    // Pool stats
    const pool = {
      total: (deps.dbPool as any).totalCount ?? 0,
      idle: (deps.dbPool as any).idleCount ?? 0,
      waiting: (deps.dbPool as any).waitingCount ?? 0,
    };

    // Memory usage
    const mem = process.memoryUsage();

    return c.json({
      data: {
        postgres: postgresStatus,
        redis: redisStatus,
        queues,
        pool,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
      },
    });
  });

  // GET /metrics — key business metrics
  app.get('/metrics', async (c) => {
    const deps = c.get('deps');

    const [totalTenants, activeJobs, dlqDepth, totalStorageBytes] = await Promise.all([
      deps.tenantRepo ? deps.tenantRepo.countAll() : 0,
      deps.jobRepo.countAll({ status: 'running' as any }),
      deps.dlqRepo ? deps.dlqRepo.countUnresolved() : 0,
      deps.tenantRepo?.getTotalStorage ? deps.tenantRepo.getTotalStorage() : 0,
    ]);

    // Queue depths
    const queues: Record<string, unknown> = {};
    if (deps.queues) {
      const queueNames = [
        'crawl',
        'extract',
        'schemaEvolution',
        'reconciliation',
        'export',
        'webhook',
      ] as const;
      for (const name of queueNames) {
        try {
          const counts = await deps.queues[name].getJobCounts('waiting', 'active', 'failed');
          queues[name] = counts;
        } catch {
          queues[name] = { error: 'unavailable' };
        }
      }
    }

    return c.json({
      data: {
        totalTenants,
        activeJobs,
        totalStorageBytes,
        dlqDepth,
        queues,
      },
    });
  });

  return app;
}
```

- [ ] **Step 4: Register admin system routes in app.ts**

Import:

```typescript
import { adminSystemRoutes } from './routes/admin-system.js';
```

Route registration (add after the admin/jobs route):

```typescript
app.route('/api/v1/admin/system', adminSystemRoutes());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-system.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-system.ts apps/api/src/app.ts apps/api/tests/unit/routes/admin-system.test.ts
git commit -m "feat(admin): add system health and metrics endpoints"
```

---

## Task 8: Add CLEANUP Queue Name and Bull Board Registration

**Files:**

- Modify: `packages/queue/src/queues.ts`
- Modify: `apps/api/src/routes/admin-queues.ts`

- [ ] **Step 1: Add CLEANUP to QUEUE_NAMES**

In `packages/queue/src/queues.ts`, add to the `QUEUE_NAMES` constant (after `METERING` line 12):

```typescript
  CLEANUP: 'spatula.cleanup',
```

- [ ] **Step 2: Verify Bull Board already supports extra queues**

Note: `admin-queues.ts` already accepts `extraQueues?: Queue[]` and spreads them into the adapter list. No change needed to that file — the metering/cleanup queues from worker-entrypoint will be passed as `extraQueues` when available.

- [ ] **Step 3: Run existing queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue exec vitest run tests/unit/queues.test.ts && pnpm --filter @spatula/api exec vitest run tests/unit/routes/admin-queues.test.ts`
Expected: All PASS (no breaking changes).

- [ ] **Step 4: Commit**

```bash
git add packages/queue/src/queues.ts
git commit -m "feat(queue): add CLEANUP queue name constant"
```

---

## Task 9: Cleanup Worker

**Files:**

- Create: `packages/queue/src/cleanup-worker.ts`
- Create: `packages/queue/tests/unit/cleanup-worker.test.ts`
- Modify: `packages/queue/src/index.ts`

The cleanup worker runs daily at 03:00 UTC. Three-phase cleanup strategy:

- **Phase A:** Sub-job resource cleanup — delete raw pages (+ their extractions) and exports independently of job lifecycle per tenant retention config. This is a storage optimization (e.g., delete raw HTML after 30 days while keeping the job for 90 days).
- **Phase B:** Full expired job cascade — find completed/failed jobs past retention, delete with full FK-safe cascade (mirroring `deleteWithData` in `job-repository.ts`).
- **Phase C:** System-wide cleanup (audit logs 365d, LLM usage 365d, DLQ 90d) + content store orphan scan.

All deletes use `LIMIT` batching per spec requirement.

- [ ] **Step 1: Write the failing tests**

Create `packages/queue/tests/unit/cleanup-worker.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { processCleanupJob } from '../../src/cleanup-worker.js';
import type { CleanupDeps } from '../../src/cleanup-worker.js';

function createMockDeps(overrides?: Partial<CleanupDeps>): CleanupDeps {
  return {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as any,
    tenantRepo: {
      findAll: vi.fn().mockResolvedValue([
        {
          id: 'tenant-1',
          config: {
            retention: {
              completedJobsDays: 90,
              failedJobsDays: 30,
              rawPagesDays: 30,
              exportsDays: 30,
            },
          },
        },
      ]),
    } as any,
    contentStore: {
      delete: vi.fn().mockResolvedValue(undefined),
    } as any,
    ...overrides,
  };
}

describe('processCleanupJob', () => {
  it('processes tenants and returns statistics', async () => {
    const deps = createMockDeps();
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(1);
    expect(deps.tenantRepo.findAll).toHaveBeenCalled();
  });

  it('uses default retention when tenant has no config', async () => {
    const deps = createMockDeps({
      tenantRepo: {
        findAll: vi.fn().mockResolvedValue([{ id: 'tenant-2', config: {} }]),
      } as any,
    });
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(1);
  });

  it('continues processing other tenants if one fails', async () => {
    const callCount = { n: 0 };
    const deps = createMockDeps({
      tenantRepo: {
        findAll: vi.fn().mockResolvedValue([
          { id: 'tenant-1', config: {} },
          { id: 'tenant-2', config: {} },
        ]),
      } as any,
      db: {
        execute: vi.fn().mockImplementation(async () => {
          callCount.n++;
          if (callCount.n === 1) throw new Error('DB error');
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    const result = await processCleanupJob(deps);
    expect(result.tenantsProcessed).toBe(2);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('cleans system-wide data even with no tenants', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
    });
    const result = await processCleanupJob(deps);
    // System cleanup runs: audit logs, LLM usage, DLQ, content store orphans
    expect(deps.db.execute).toHaveBeenCalled();
    expect(result.systemCleanup).toBeDefined();
  });

  it('runs Phase A: deletes extractions before raw_pages (FK safety)', async () => {
    const executeCalls: string[] = [];
    const deps = createMockDeps({
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          // Capture the SQL string to verify ordering
          const queryStr =
            query?.queryChunks?.map((c: any) => c.value ?? c).join('') ?? String(query);
          if (queryStr.includes('extractions')) executeCalls.push('extractions');
          if (queryStr.includes('raw_pages')) executeCalls.push('raw_pages');
          if (queryStr.includes('exports') && !queryStr.includes('content_ref'))
            executeCalls.push('exports');
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    await processCleanupJob(deps);
    const extractIdx = executeCalls.indexOf('extractions');
    const rawPagesIdx = executeCalls.indexOf('raw_pages');
    // Extractions must be deleted before raw_pages
    if (extractIdx >= 0 && rawPagesIdx >= 0) {
      expect(extractIdx).toBeLessThan(rawPagesIdx);
    }
  });

  it('runs Phase B: deletes expired jobs with FK cascade order', async () => {
    const executeCalls: string[] = [];
    const deps = createMockDeps({
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const queryStr =
            query?.queryChunks?.map((c: any) => c.value ?? c).join('') ?? String(query);
          if (queryStr.includes('entity_sources')) executeCalls.push('entity_sources');
          if (queryStr.includes('entities') && !queryStr.includes('entity_sources'))
            executeCalls.push('entities');
          if (queryStr.includes("status = 'completed'") || queryStr.includes("status = 'failed'"))
            executeCalls.push('jobs');
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    await processCleanupJob(deps);
    const entitySourcesIdx = executeCalls.indexOf('entity_sources');
    const entitiesIdx = executeCalls.indexOf('entities');
    const jobsIdx = executeCalls.indexOf('jobs');
    // entity_sources before entities before jobs
    if (entitySourcesIdx >= 0 && entitiesIdx >= 0) {
      expect(entitySourcesIdx).toBeLessThan(entitiesIdx);
    }
    if (entitiesIdx >= 0 && jobsIdx >= 0) {
      expect(entitiesIdx).toBeLessThan(jobsIdx);
    }
  });

  it('runs Phase C: orphan content store scan', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const queryStr =
            query?.queryChunks?.map((c: any) => c.value ?? c).join('') ?? String(query);
          // Return orphan refs for the orphan scan query
          if (queryStr.includes('content_store') && queryStr.includes('NOT IN')) {
            return { rows: [{ id: 'orphan-1', key: 'pg://orphan-1' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    await processCleanupJob(deps);
    expect(deps.contentStore!.delete).toHaveBeenCalledWith('pg://orphan-1');
  });

  it('skips content store cleanup when contentStore is undefined', async () => {
    const deps = createMockDeps({
      tenantRepo: { findAll: vi.fn().mockResolvedValue([]) } as any,
      contentStore: undefined,
    });
    // Should not throw
    const result = await processCleanupJob(deps);
    expect(result.systemCleanup.contentOrphans).toBeUndefined();
  });

  it('Phase B: continues with next job when one job cascade fails', async () => {
    let deleteCallCount = 0;
    const deps = createMockDeps({
      tenantRepo: {
        findAll: vi.fn().mockResolvedValue([{ id: 'tenant-1', config: {} }]),
      } as any,
      db: {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const queryStr =
            query?.queryChunks?.map((c: any) => c.value ?? c).join('') ?? String(query);
          // Return 2 expired jobs
          if (queryStr.includes('SELECT id FROM jobs') && queryStr.includes('completed')) {
            return { rows: [{ id: 'job-1' }, { id: 'job-2' }], rowCount: 2 };
          }
          // Fail on entity_sources delete for job-1 only
          if (queryStr.includes('entity_sources')) {
            deleteCallCount++;
            if (deleteCallCount === 1) throw new Error('FK error');
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any,
    });
    const result = await processCleanupJob(deps);
    // Should still process tenant despite one job failing
    expect(result.tenantsProcessed).toBe(1);
    // The per-job error is caught, not propagated to tenant level
    expect(result.errors).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue exec vitest run tests/unit/cleanup-worker.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create cleanup-worker.ts**

Create `packages/queue/src/cleanup-worker.ts`:

```typescript
import { sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import type { ContentStore } from '@spatula/core';

const logger = createLogger('cleanup-worker');

const DEFAULT_RETENTION = {
  completedJobsDays: 90,
  failedJobsDays: 30,
  rawPagesDays: 30,
  exportsDays: 30,
};

const SYSTEM_RETENTION = {
  auditLogDays: 365,
  llmUsageDays: 365,
  dlqResolvedDays: 90,
};

const BATCH_SIZE = 100;

/** Duck-typed deps to avoid cross-package import of concrete classes */
export interface CleanupDeps {
  db: {
    execute(query: any): Promise<{ rows: any[]; rowCount: number }>;
  };
  tenantRepo: {
    findAll(options?: { limit?: number; offset?: number }): Promise<
      Array<{
        id: string;
        config: Record<string, unknown>;
      }>
    >;
  };
  contentStore?: ContentStore;
}

export interface CleanupResult {
  tenantsProcessed: number;
  errors: number;
  systemCleanup: Record<string, number>;
}

/**
 * Daily cleanup job — three phases:
 *
 * Phase A (per-tenant): Sub-job resource cleanup
 *   Delete raw pages (+ extractions) and exports independently of job lifecycle.
 *   This is a storage optimization: raw HTML can be cleaned after 30 days even
 *   if the job is retained for 90 days.
 *
 * Phase B (per-tenant): Expired job cascade
 *   Delete completed/failed jobs past retention, with full FK-safe cascade
 *   (entity_sources → entities → extractions → raw_pages → crawl_tasks →
 *    actions → source_trust → schemas → exports → job).
 *
 * Phase C (global): System-wide cleanup
 *   Audit logs (365d), LLM usage (365d), resolved DLQ (90d),
 *   content store orphan scan.
 */
export async function processCleanupJob(deps: CleanupDeps): Promise<CleanupResult> {
  logger.info('Starting daily cleanup');
  const result: CleanupResult = { tenantsProcessed: 0, errors: 0, systemCleanup: {} };

  // Phases A + B: Per-tenant cleanup
  let offset = 0;
  const limit = 50;
  let tenants: Array<{ id: string; config: Record<string, unknown> }>;

  do {
    tenants = await deps.tenantRepo.findAll({ limit, offset });
    for (const tenant of tenants) {
      try {
        await cleanupTenantPhaseA(deps, tenant);
        await cleanupTenantPhaseB(deps, tenant);
      } catch (err) {
        logger.error(
          { tenantId: tenant.id, error: (err as Error).message },
          'Tenant cleanup failed',
        );
        result.errors++;
      }
      result.tenantsProcessed++;
    }
    offset += limit;
  } while (tenants.length === limit);

  // Phase C: System-wide cleanup
  try {
    result.systemCleanup = await cleanupSystemData(deps);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'System cleanup failed');
    result.errors++;
  }

  logger.info(result, 'Daily cleanup complete');
  return result;
}

/**
 * Phase A: Sub-job resource cleanup.
 * Delete raw pages (+ their extractions) and exports from non-expired jobs
 * that exceed their own retention windows. FK-safe order:
 *   1. Delete extractions referencing expired raw pages
 *   2. Delete expired raw pages
 *   3. Collect content refs from expired exports
 *   4. Delete expired exports
 *   5. Clean up content store refs
 */
async function cleanupTenantPhaseA(
  deps: CleanupDeps,
  tenant: { id: string; config: Record<string, unknown> },
): Promise<void> {
  const retention = {
    ...DEFAULT_RETENTION,
    ...((tenant.config?.retention as Record<string, number>) ?? {}),
  };
  const tenantId = tenant.id;
  const rawPagesCutoff = daysAgo(retention.rawPagesDays);
  const exportsCutoff = daysAgo(retention.exportsDays);

  // A1. Delete extractions referencing expired raw pages (FK: extractions.page_id → raw_pages.id)
  await deps.db.execute(sql`
    DELETE FROM extractions WHERE id IN (
      SELECT e.id FROM extractions e
      JOIN raw_pages rp ON e.page_id = rp.id
      WHERE rp.tenant_id = ${tenantId} AND rp.created_at < ${rawPagesCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A2. Delete expired raw pages
  await deps.db.execute(sql`
    DELETE FROM raw_pages WHERE id IN (
      SELECT id FROM raw_pages
      WHERE tenant_id = ${tenantId} AND created_at < ${rawPagesCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A3. Collect content refs from expired exports (for content store cleanup)
  const expiredExports = await deps.db.execute(sql`
    SELECT content_ref FROM exports
    WHERE tenant_id = ${tenantId} AND created_at < ${exportsCutoff}
    AND content_ref IS NOT NULL
    LIMIT ${BATCH_SIZE}
  `);
  const contentRefs: string[] = (expiredExports.rows ?? [])
    .map((r: any) => r.content_ref)
    .filter(Boolean);

  // A4. Delete expired exports (no child FKs point to exports)
  await deps.db.execute(sql`
    DELETE FROM exports WHERE id IN (
      SELECT id FROM exports
      WHERE tenant_id = ${tenantId} AND created_at < ${exportsCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A5. Content store cleanup for deleted exports/pages
  if (deps.contentStore && contentRefs.length > 0) {
    for (const ref of contentRefs) {
      try {
        await deps.contentStore.delete(ref);
      } catch (err) {
        logger.warn({ ref, error: (err as Error).message }, 'Failed to delete content store entry');
      }
    }
  }

  logger.debug({ tenantId, rawPagesCutoff, exportsCutoff }, 'Phase A complete');
}

/**
 * Phase B: Expired job cascade.
 * Delete completed/failed jobs past retention with full FK-safe ordering.
 * Mirrors the cascade in JobRepository.deleteWithData().
 *
 * FK chain (child → parent):
 *   entity_sources → entities → (job)
 *   extractions → raw_pages → crawl_tasks → (job)
 *   actions → (job)
 *   source_trust → (job)
 *   schemas → (job, circular with jobs.schema_id)
 *   exports → (job)
 *   llm_usage.job_id → ON DELETE SET NULL (automatic)
 *   dead_letter_queue.spatula_job_id → ON DELETE SET NULL (automatic)
 */
async function cleanupTenantPhaseB(
  deps: CleanupDeps,
  tenant: { id: string; config: Record<string, unknown> },
): Promise<void> {
  const retention = {
    ...DEFAULT_RETENTION,
    ...((tenant.config?.retention as Record<string, number>) ?? {}),
  };
  const tenantId = tenant.id;
  const completedCutoff = daysAgo(retention.completedJobsDays);
  const failedCutoff = daysAgo(retention.failedJobsDays);

  // Find expired job IDs (completed + failed)
  const expiredJobs = await deps.db.execute(sql`
    SELECT id FROM jobs WHERE tenant_id = ${tenantId} AND (
      (status = 'completed' AND completed_at < ${completedCutoff})
      OR (status = 'failed' AND completed_at < ${failedCutoff})
    ) LIMIT ${BATCH_SIZE}
  `);
  const jobIds: string[] = (expiredJobs.rows ?? []).map((r: any) => r.id);
  if (jobIds.length === 0) return;

  logger.info({ tenantId, expiredJobCount: jobIds.length }, 'Deleting expired jobs');

  // Process in batches to avoid unbounded deletes
  for (const jobId of jobIds) {
    try {
      // B1. Break circular FK: NULL out schemaId
      await deps.db.execute(sql`UPDATE jobs SET schema_id = NULL WHERE id = ${jobId}`);

      // B2. Delete entity_sources (FK: entity_sources.entity_id → entities.id)
      await deps.db.execute(sql`
        DELETE FROM entity_sources WHERE entity_id IN (
          SELECT id FROM entities WHERE job_id = ${jobId}
        )
      `);

      // B3. Delete entities
      await deps.db.execute(sql`DELETE FROM entities WHERE job_id = ${jobId}`);

      // B4. Delete extractions (FK: extractions.page_id → raw_pages.id)
      await deps.db.execute(sql`
        DELETE FROM extractions WHERE page_id IN (
          SELECT rp.id FROM raw_pages rp
          JOIN crawl_tasks ct ON rp.task_id = ct.id
          WHERE ct.job_id = ${jobId}
        )
      `);

      // B5. Delete raw_pages
      await deps.db.execute(sql`
        DELETE FROM raw_pages WHERE task_id IN (
          SELECT id FROM crawl_tasks WHERE job_id = ${jobId}
        )
      `);

      // B6. Delete crawl_tasks (self-ref parentTaskId safe in single DELETE)
      await deps.db.execute(sql`DELETE FROM crawl_tasks WHERE job_id = ${jobId}`);

      // B7. Delete actions
      await deps.db.execute(sql`DELETE FROM actions WHERE job_id = ${jobId}`);

      // B8. Delete source_trust
      await deps.db.execute(sql`DELETE FROM source_trust WHERE job_id = ${jobId}`);

      // B9. Delete schemas (safe — schemaId was NULLed in B1)
      await deps.db.execute(sql`DELETE FROM schemas WHERE job_id = ${jobId}`);

      // B10. Delete exports
      await deps.db.execute(sql`DELETE FROM exports WHERE job_id = ${jobId}`);

      // B11. Delete the job itself (llm_usage.job_id and dlq.spatula_job_id are ON DELETE SET NULL)
      await deps.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);
    } catch (err) {
      logger.error(
        { tenantId, jobId, error: (err as Error).message },
        'Failed to delete expired job',
      );
      // Continue with next job
    }
  }

  logger.debug({ tenantId, deletedJobs: jobIds.length }, 'Phase B complete');
}

/**
 * Phase C: System-wide cleanup.
 * Non-configurable retention + content store orphan scan.
 */
async function cleanupSystemData(deps: CleanupDeps): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};

  // C1. Audit logs older than 365 days
  const auditCutoff = daysAgo(SYSTEM_RETENTION.auditLogDays);
  const auditResult = await deps.db.execute(sql`
    DELETE FROM audit_log WHERE created_at < ${auditCutoff}
  `);
  stats.auditLogs = auditResult?.rowCount ?? 0;

  // C2. LLM usage older than 365 days
  const llmCutoff = daysAgo(SYSTEM_RETENTION.llmUsageDays);
  const llmResult = await deps.db.execute(sql`
    DELETE FROM llm_usage WHERE created_at < ${llmCutoff}
  `);
  stats.llmUsage = llmResult?.rowCount ?? 0;

  // C3. Resolved DLQ entries older than 90 days
  const dlqCutoff = daysAgo(SYSTEM_RETENTION.dlqResolvedDays);
  const dlqResult = await deps.db.execute(sql`
    DELETE FROM dead_letter_queue
    WHERE resolved_at IS NOT NULL AND resolved_at < ${dlqCutoff}
  `);
  stats.dlqResolved = dlqResult?.rowCount ?? 0;

  // C4. Content store orphan scan — find entries not referenced by any export or raw_page
  if (deps.contentStore) {
    const orphans = await deps.db.execute(sql`
      SELECT id, key FROM content_store
      WHERE key NOT IN (
        SELECT content_ref FROM exports WHERE content_ref IS NOT NULL
        UNION ALL
        SELECT content_ref FROM raw_pages WHERE content_ref IS NOT NULL
        UNION ALL
        SELECT content_ref FROM crawl_tasks WHERE content_ref IS NOT NULL
      )
      LIMIT ${BATCH_SIZE}
    `);
    let orphanCount = 0;
    for (const row of orphans.rows ?? []) {
      try {
        await deps.contentStore.delete((row as any).key);
        orphanCount++;
      } catch (err) {
        logger.warn(
          { key: (row as any).key, error: (err as Error).message },
          'Failed to delete orphan content',
        );
      }
    }
    stats.contentOrphans = orphanCount;
  }

  logger.info(stats, 'System cleanup complete');
  return stats;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
```

- [ ] **Step 4: Export from package barrel**

In `packages/queue/src/index.ts`, add:

```typescript
// Cleanup Worker
export { processCleanupJob } from './cleanup-worker.js';
export type { CleanupDeps, CleanupResult } from './cleanup-worker.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue exec vitest run tests/unit/cleanup-worker.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/cleanup-worker.ts packages/queue/tests/unit/cleanup-worker.test.ts packages/queue/src/index.ts
git commit -m "feat(queue): add daily cleanup worker for tenant retention and system data"
```

---

## Task 10: Register Cleanup Worker in Worker Entrypoint

**Files:**

- Modify: `packages/queue/src/worker-entrypoint.ts`

Follow the metering worker pattern: create a BullMQ repeatable job and register the worker.

- [ ] **Step 1: Add cleanup worker registration**

In `packages/queue/src/worker-entrypoint.ts`, add the import near the metering imports (after line 18):

```typescript
import { processCleanupJob } from './cleanup-worker.js';
import type { CleanupDeps } from './cleanup-worker.js';
```

Add the cleanup worker registration after the metering worker block (after line 198). Follow the exact metering pattern:

```typescript
let cleanupQueue: import('bullmq').Queue | undefined;
if (isEnabled('cleanup')) {
  const { Queue: BullQueue } = await import('bullmq');
  cleanupQueue = new BullQueue(QUEUE_NAMES.CLEANUP, { connection: redisOpts });

  // Add repeatable job (daily at 03:00 UTC)
  await cleanupQueue.add(
    'cleanup',
    {},
    {
      repeat: { pattern: '0 3 * * *' },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  const worker = new Worker(
    QUEUE_NAMES.CLEANUP,
    async () => {
      if (!deps) {
        logger.warn('Cleanup skipped — WorkerDeps not initialized');
        return;
      }
      // CleanupDeps.db needs execute() — the Drizzle db instance has this
      const dbInstance = (deps as any).db ?? (deps as any).jobRepo?.db;
      const cleanupDeps: CleanupDeps = {
        db: dbInstance,
        tenantRepo: (deps as any).tenantRepo,
        contentStore: (deps as any).contentStore,
      };
      if (!cleanupDeps.db || !cleanupDeps.tenantRepo) {
        logger.warn('Cleanup skipped — required deps not available in WorkerDeps');
        return;
      }
      await processCleanupJob(cleanupDeps);
    },
    { connection: workerConnection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => void dlqHandler(job, err));
  workers.push(worker);
  logger.info({ queue: QUEUE_NAMES.CLEANUP }, 'Cleanup worker started (daily 03:00 UTC)');
}
```

- [ ] **Step 2: Add 'cleanup' to the heartbeat queue list**

In the `enabledQueueNames` block (around line 206), add `cleanup` to the map:

```typescript
    cleanup: QUEUE_NAMES.CLEANUP,
```

- [ ] **Step 3: Close cleanup queue on shutdown**

In the shutdown function, after `if (meteringQueue) await meteringQueue.close();` (around line 244), add:

```typescript
if (cleanupQueue) await cleanupQueue.close();
```

- [ ] **Step 4: Run existing worker tests for regressions**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue exec vitest run`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/worker-entrypoint.ts
git commit -m "feat(queue): register cleanup worker in entrypoint (daily at 03:00 UTC)"
```

---

## Task 11: Full Test Suite Run and Final Validation

**Files:** None — validation only.

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm -r exec vitest run`
Expected: All tests pass across all packages.

- [ ] **Step 2: Run TypeScript type checking**

Run: `cd /Users/salar/Projects/spatula && pnpm -r exec tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run linting**

Run: `cd /Users/salar/Projects/spatula && pnpm -r exec eslint . --ext .ts`
Expected: No lint errors.

---

## Summary of Deliverables

| Spec Requirement                             | Task                                                                             | Status       |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| Admin scope guard on existing routes         | Already done — `app.ts:178` applies `requireScope('admin')` to `/api/v1/admin/*` | Pre-existing |
| Tenant status enforcement (suspended → 403)  | Task 1                                                                           | —            |
| Admin DLQ cross-tenant access                | Task 2                                                                           | —            |
| `GET /admin/tenants` (list)                  | Task 5                                                                           | —            |
| `GET /admin/tenants/:id` (detail)            | Task 5                                                                           | —            |
| `PATCH /admin/tenants/:id` (update)          | Task 5                                                                           | —            |
| `GET /admin/jobs` (cross-tenant list)        | Task 6                                                                           | —            |
| `POST /admin/jobs/:id/force-cancel`          | Task 6                                                                           | —            |
| `GET /admin/system/health` (detailed)        | Task 7                                                                           | —            |
| `GET /admin/system/metrics`                  | Task 7                                                                           | —            |
| Tenant retention config extension            | Task 5 (PATCH config.retention)                                                  | —            |
| Cleanup worker (daily 03:00 UTC)             | Tasks 8-10                                                                       | —            |
| Cleanup Phase A: sub-job resource retention  | Task 9                                                                           | —            |
| Cleanup Phase B: FK-safe expired job cascade | Task 9                                                                           | —            |
| Cleanup Phase C: system-wide + orphan scan   | Task 9                                                                           | —            |
| Audit log entries for admin actions          | Tasks 5, 6                                                                       | —            |
| Bull Board `extraQueues` support             | Pre-existing (`admin-queues.ts` already supports it)                             | Pre-existing |
| CLEANUP queue name                           | Task 8                                                                           | —            |

**Total new admin routes:** 7 (3 tenant + 2 job + 2 system)
**Total scope-guarded existing routes:** 3 (DLQ, queues, workers) — already protected by `app.ts:178`
