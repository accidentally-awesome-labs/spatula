# Phase 8: API Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Hono-based REST API server that exposes all Spatula platform capabilities — job lifecycle management, schema browsing, extraction/entity data access, and action review workflows — as a production-quality HTTP service.

**Architecture:** The API is a thin HTTP layer over the existing core engine, DB repositories, and queue system. A factory function creates the Hono app with middleware (error handling, tenant extraction, request validation, logging). Route modules are organized by resource (jobs, schemas, extractions, entities, actions). Each route handler receives dependencies via a typed context object injected by middleware, keeping handlers pure and testable. Request/response schemas are validated with Zod.

**Tech Stack:** Hono (HTTP framework), @hono/node-server (runtime), Zod (validation), vitest (testing), existing @spatula/db, @spatula/queue, @spatula/core, @spatula/shared packages

---

## Context & Pre-existing Code

**Already defined (Phase 1-7):**
- `JobConfig`, `JobStatus`, `SchemaDefinition`, `FieldDefinition` — in `packages/core/src/types/`
- `ExtractionResult`, `EntityMatch`, `FieldProvenanceEntry` — in `packages/core/src/types/`
- 25 `PipelineAction` types + `ActionStatus`, `ActionSource` — in `packages/core/src/types/actions.ts`
- Error classes: `SpatulaError`, `ValidationError`, `StorageError`, etc. — in `packages/shared/src/errors.ts`
- `createLogger()` — in `packages/shared/src/logger.ts`

**Already defined (Phase 4 DB):**
- `JobRepository` — create, findById, findByTenant, updateStatus, updateStats
- `SchemaRepository` — create, findLatest, findByVersion, findAllVersions
- `ExtractionRepository` — store, findByJob, findByPage
- `EntityRepository` — create, findById, findByJob, updateQualityScore
- `EntitySourceRepository` — link, bulkLink, findByEntity
- `SourceTrustRepository` — upsert, findByJob, findByDomain
- `CrawlTaskRepository` — enqueue, findByJob, updateStatus, updateClassification
- `PageRepository` — create, findByContentHash, findByTask, findByIds
- `createDatabase()` + `Database` type — in `packages/db/src/connection.ts`
- Actions table schema exists but **NO ActionRepository yet** — must create in this phase

**Already defined (Phase 5 queue):**
- `JobManager` — createJob, startJob, pauseJob, resumeJob, cancelJob, triggerReconciliation, getJobStatus
- `JobStateMachine` — validates state transitions
- `createQueues()`, `QUEUE_NAMES`, `SpatulaQueues`

**DB Enums (from `packages/db/src/schema/enums.ts`):**
- `job_status`: pending, queued, running, paused, reconciling, completed, failed, cancelled
- `action_status`: pending_review, approved, applied, rejected, rolled_back
- `action_source`: extraction, schema_evolution, reconciliation, quality_audit

**Current API app state:**
- `apps/api/package.json` — has only `@spatula/core` and `@spatula/shared` deps; NO Hono
- `apps/api/src/index.ts` — placeholder comment only

---

## Task 1: Project Setup — Install Dependencies & Configure Test Infrastructure

Install Hono and set up the test runner for the API package.

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/vitest.config.ts`
- Modify: `apps/api/tsconfig.json` (add test path if needed)

### Step 1: Install Hono and related dependencies

Run:
```bash
cd apps/api && pnpm add hono @hono/node-server zod @spatula/db @spatula/queue
```

### Step 2: Install test dev dependencies

Run:
```bash
cd apps/api && pnpm add -D vitest @types/node
```

### Step 3: Create vitest config

Create `apps/api/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

### Step 4: Add test script to package.json

Add to `apps/api/package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

### Step 5: Verify setup

Run:
```bash
cd apps/api && pnpm build
```
Expected: Success (no source changes yet)

### Step 6: Commit

```bash
git add apps/api/package.json apps/api/vitest.config.ts
git commit -m "chore(api): install hono, zod, db/queue deps and vitest config"
```

---

## Task 2: ActionRepository — DB Repository for Actions Table

The actions table exists but has no repository. API endpoints need CRUD access to actions for the review workflow.

**Files:**
- Create: `packages/db/src/repositories/action-repository.ts`
- Modify: `packages/db/src/repositories/index.ts` (add export)
- Test: `packages/db/tests/unit/repositories/action-repository.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionRepository } from '../../../src/repositories/action-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'action-id', status: 'pending_review' }]),
    set: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'action-id', status: 'pending_review' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'action-id' }]),
      }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ActionRepository', () => {
  let repo: ActionRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ActionRepository(mockDb as any);
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('has batchUpdateStatus method', () => {
    expect(typeof repo.batchUpdateStatus).toBe('function');
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob('job-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateStatus calls db.update', async () => {
    await repo.updateStatus('action-id', 'tenant-id', 'approved', 'user-1');
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('findByJob wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: vi.fn((_: unknown, reject: (v: unknown) => void) => reject(new Error('db error'))),
    };
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findByJob('job-id', 'tenant-id')).rejects.toThrow(
      'Failed to find actions',
    );
  });

  it('updateStatus wraps errors in StorageError', async () => {
    const failChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue(new Error('db error')),
      then: vi.fn((_: unknown, reject: (v: unknown) => void) => reject(new Error('db error'))),
    };
    mockDb.update = vi.fn().mockReturnValue(failChainable);

    await expect(
      repo.updateStatus('action-id', 'tenant-id', 'approved', 'user-1'),
    ).rejects.toThrow('Failed to update action status');
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/action-repository.test.ts`
Expected: FAIL — module not found

### Step 3: Write the ActionRepository

Create `packages/db/src/repositories/action-repository.ts`:
```typescript
import { eq, and, desc, inArray } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { actions } from '../schema/actions.js';
import type { Database } from '../connection.js';

const logger = createLogger('action-repository');

export type ActionStatus = 'pending_review' | 'approved' | 'applied' | 'rejected' | 'rolled_back';

export interface FindActionsOptions {
  type?: string;
  status?: ActionStatus;
  limit?: number;
  offset?: number;
}

export class ActionRepository {
  constructor(private readonly db: Database) {}

  async findByJob(jobId: string, tenantId: string, options?: FindActionsOptions) {
    try {
      let query = this.db
        .select()
        .from(actions)
        .where(and(eq(actions.jobId, jobId), eq(actions.tenantId, tenantId)))
        .orderBy(desc(actions.createdAt));

      if (options?.type) {
        query = query.where(
          and(eq(actions.jobId, jobId), eq(actions.tenantId, tenantId), eq(actions.type, options.type)),
        ) as typeof query;
      }

      if (options?.status) {
        query = query.where(
          and(eq(actions.jobId, jobId), eq(actions.tenantId, tenantId), eq(actions.status, options.status)),
        ) as typeof query;
      }

      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }

      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find actions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findById(actionId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(actions)
        .where(and(eq(actions.id, actionId), eq(actions.tenantId, tenantId)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find action ${actionId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { actionId, tenantId },
      });
    }
  }

  async updateStatus(
    actionId: string,
    tenantId: string,
    status: ActionStatus,
    reviewedBy?: string,
  ) {
    try {
      const [row] = await this.db
        .update(actions)
        .set({
          status,
          ...(reviewedBy ? { reviewedBy } : {}),
          ...(status === 'applied' ? { appliedAt: new Date() } : {}),
        })
        .where(and(eq(actions.id, actionId), eq(actions.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Action ${actionId} not found`, {
          context: { actionId, tenantId },
        });
      }

      logger.debug({ actionId, status }, 'action status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update action status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { actionId, tenantId, status },
      });
    }
  }

  async batchUpdateStatus(
    actionIds: string[],
    tenantId: string,
    status: ActionStatus,
    reviewedBy?: string,
  ) {
    try {
      const rows = await this.db
        .update(actions)
        .set({
          status,
          ...(reviewedBy ? { reviewedBy } : {}),
          ...(status === 'applied' ? { appliedAt: new Date() } : {}),
        })
        .where(and(inArray(actions.id, actionIds), eq(actions.tenantId, tenantId)))
        .returning();

      logger.debug({ count: rows.length, status }, 'batch action status updated');
      return rows;
    } catch (error) {
      throw new StorageError(`Failed to batch update action status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { count: actionIds.length, status },
      });
    }
  }
}
```

### Step 4: Export from repositories barrel

Add to `packages/db/src/repositories/index.ts`:
```typescript
export { ActionRepository } from './action-repository.js';
export type { ActionStatus, FindActionsOptions } from './action-repository.js';
```

### Step 5: Run tests to verify they pass

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/action-repository.test.ts`
Expected: PASS

### Step 6: Run full db package tests + build

Run: `cd packages/db && pnpm vitest run && pnpm build`
Expected: All pass, build succeeds

### Step 7: Commit

```bash
git add packages/db/src/repositories/action-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/action-repository.test.ts
git commit -m "feat(db): add ActionRepository for actions table CRUD"
```

---

## Task 3: Error Handling Middleware & App Factory

Create the Hono app factory with structured error handling middleware that maps domain errors to HTTP responses.

**Files:**
- Create: `apps/api/src/middleware/error-handler.ts`
- Create: `apps/api/src/app.ts`
- Test: `apps/api/tests/unit/middleware/error-handler.test.ts`

### Step 1: Write failing tests for error handler

```typescript
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import { ValidationError, StorageError } from '@spatula/shared';

function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  it('maps ValidationError to 400', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationError('bad input');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('bad input');
  });

  it('maps StorageError to 500', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new StorageError('db down');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('STORAGE_ERROR');
  });

  it('maps unknown errors to 500 with generic message', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('unexpected');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('includes requestId in error response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('fail');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.requestId).toBeDefined();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/error-handler.test.ts`
Expected: FAIL — module not found

### Step 3: Write error handler middleware

Create `apps/api/src/middleware/error-handler.ts`:
```typescript
import type { ErrorHandler } from 'hono';
import { SpatulaError, ValidationError, createLogger } from '@spatula/shared';

const logger = createLogger('api:error-handler');

export class NotFoundError extends SpatulaError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, 'NOT_FOUND', { context: { resource, id } });
  }
}

export class ConflictError extends SpatulaError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

function mapErrorToStatus(error: unknown): number {
  if (error instanceof SpatulaError) {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return 400;
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
        return 409;
      default:
        return 500;
    }
  }
  return 500;
}

export const errorHandler: ErrorHandler = (error, c) => {
  const status = mapErrorToStatus(error);
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();

  if (status >= 500) {
    logger.error({ err: error, requestId, path: c.req.path }, 'unhandled error');
  } else {
    logger.warn({ code: (error as SpatulaError).code, requestId, path: c.req.path }, error.message);
  }

  const code =
    error instanceof SpatulaError ? error.code : 'INTERNAL_ERROR';
  const message =
    status >= 500 && !(error instanceof SpatulaError)
      ? 'Internal server error'
      : error.message;

  return c.json(
    {
      error: {
        code,
        message,
        requestId,
      },
    },
    status as any,
  );
};
```

### Step 4: Write the app factory

Create `apps/api/src/app.ts`:
```typescript
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import type { AppEnv } from './types.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', honoLogger());

  // Error handler
  app.onError(errorHandler);

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  return app;
}
```

Create `apps/api/src/types.ts`:
```typescript
import type { JobRepository, SchemaRepository, ExtractionRepository, EntityRepository, EntitySourceRepository, ActionRepository, CrawlTaskRepository } from '@spatula/db';
import type { JobManager } from '@spatula/queue';

export interface AppDeps {
  jobRepo: JobRepository;
  schemaRepo: SchemaRepository;
  extractionRepo: ExtractionRepository;
  entityRepo: EntityRepository;
  entitySourceRepo: EntitySourceRepository;
  actionRepo: ActionRepository;
  taskRepo: CrawlTaskRepository;
  jobManager: JobManager;
}

export interface AppEnv {
  Variables: {
    tenantId: string;
    deps: AppDeps;
  };
}
```

### Step 5: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/error-handler.test.ts`
Expected: PASS

### Step 6: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 7: Commit

```bash
git add apps/api/src/middleware/error-handler.ts apps/api/src/app.ts apps/api/src/types.ts apps/api/tests/unit/middleware/error-handler.test.ts
git commit -m "feat(api): add error handler middleware and Hono app factory"
```

---

## Task 4: Tenant & Dependency Injection Middleware

Create middleware that extracts tenant ID from request headers and injects dependencies into the Hono context.

**Files:**
- Create: `apps/api/src/middleware/tenant.ts`
- Create: `apps/api/src/middleware/deps.ts`
- Test: `apps/api/tests/unit/middleware/tenant.test.ts`
- Test: `apps/api/tests/unit/middleware/deps.test.ts`

### Step 1: Write failing tests for tenant middleware

```typescript
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { tenantMiddleware } from '../../../src/middleware/tenant.js';

describe('tenantMiddleware', () => {
  it('extracts tenant ID from x-tenant-id header', async () => {
    const app = new Hono();
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ tenantId: c.get('tenantId') }));

    const res = await app.request('/test', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const app = new Hono();
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when x-tenant-id is not a valid UUID', async () => {
    const app = new Hono();
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-tenant-id': 'not-a-uuid' },
    });
    expect(res.status).toBe(400);
  });

  it('skips tenant check for /health endpoint', async () => {
    const app = new Hono();
    app.use('*', tenantMiddleware);
    app.get('/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
```

### Step 2: Write failing tests for deps middleware

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { depsMiddleware } from '../../../src/middleware/deps.js';
import type { AppDeps } from '../../../src/types.js';

describe('depsMiddleware', () => {
  it('injects deps into context', async () => {
    const mockDeps = { jobRepo: { findById: vi.fn() } } as unknown as AppDeps;
    const app = new Hono();
    app.use('*', depsMiddleware(mockDeps));
    app.get('/test', (c) => {
      const deps = c.get('deps');
      return c.json({ hasDeps: !!deps });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasDeps).toBe(true);
  });
});
```

### Step 3: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/`
Expected: FAIL — modules not found

### Step 4: Write tenant middleware

Create `apps/api/src/middleware/tenant.ts`:
```typescript
import type { MiddlewareHandler } from 'hono';
import { ValidationError } from '@spatula/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_PATHS = new Set(['/health']);

export const tenantMiddleware: MiddlewareHandler = async (c, next) => {
  if (SKIP_PATHS.has(c.req.path)) {
    return next();
  }

  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    throw new ValidationError('x-tenant-id header is required');
  }

  if (!UUID_REGEX.test(tenantId)) {
    throw new ValidationError('x-tenant-id must be a valid UUID');
  }

  c.set('tenantId', tenantId);
  return next();
};
```

### Step 5: Write deps middleware

Create `apps/api/src/middleware/deps.ts`:
```typescript
import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from '../types.js';

export function depsMiddleware(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    c.set('deps', deps);
    return next();
  };
}
```

### Step 6: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/`
Expected: PASS

### Step 7: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 8: Commit

```bash
git add apps/api/src/middleware/tenant.ts apps/api/src/middleware/deps.ts apps/api/tests/unit/middleware/tenant.test.ts apps/api/tests/unit/middleware/deps.test.ts
git commit -m "feat(api): add tenant extraction and dependency injection middleware"
```

---

## Task 5: Request Validation Helpers & Pagination

Create Zod-based request validation utilities and a shared pagination schema used across all list endpoints.

**Files:**
- Create: `apps/api/src/middleware/validate.ts`
- Create: `apps/api/src/schemas/pagination.ts`
- Test: `apps/api/tests/unit/middleware/validate.test.ts`
- Test: `apps/api/tests/unit/schemas/pagination.test.ts`

### Step 1: Write failing tests for validate middleware

```typescript
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { validateBody, validateQuery } from '../../../src/middleware/validate.js';

describe('validateBody', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('passes valid body to handler', async () => {
    const app = new Hono();
    app.post('/test', validateBody(schema), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid body', async () => {
    const app = new Hono();
    app.post('/test', validateBody(schema), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('validateQuery', () => {
  const schema = z.object({ page: z.coerce.number().int().min(1).default(1) });

  it('passes valid query params', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      return c.json({ page: c.get('validatedQuery').page });
    });

    const res = await app.request('/test?page=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(2);
  });

  it('applies defaults for missing query params', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      return c.json({ page: c.get('validatedQuery').page });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
  });
});
```

### Step 2: Write failing tests for pagination schema

```typescript
import { describe, it, expect } from 'vitest';
import { paginationSchema } from '../../../src/schemas/pagination.js';

describe('paginationSchema', () => {
  it('provides defaults', () => {
    const result = paginationSchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('accepts valid values', () => {
    const result = paginationSchema.parse({ limit: '10', offset: '20' });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(20);
  });

  it('caps limit at 100', () => {
    const result = paginationSchema.parse({ limit: '200' });
    expect(result.limit).toBe(100);
  });

  it('rejects negative offset', () => {
    expect(() => paginationSchema.parse({ offset: '-1' })).toThrow();
  });
});
```

### Step 3: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/validate.test.ts tests/unit/schemas/pagination.test.ts`
Expected: FAIL

### Step 4: Write pagination schema

Create `apps/api/src/schemas/pagination.ts`:
```typescript
import { z } from 'zod';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationParams = z.infer<typeof paginationSchema>;
```

### Step 5: Write validate middleware

Create `apps/api/src/middleware/validate.ts`:
```typescript
import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { ValidationError } from '@spatula/shared';

export function validateBody<T extends z.ZodType>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);

    if (!result.success) {
      throw new ValidationError(
        `Invalid request body: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }

    c.set('validatedBody', result.data);
    return next();
  };
}

export function validateQuery<T extends z.ZodType>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const query = c.req.query();
    const result = schema.safeParse(query);

    if (!result.success) {
      throw new ValidationError(
        `Invalid query parameters: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }

    c.set('validatedQuery', result.data);
    return next();
  };
}
```

### Step 6: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/middleware/ tests/unit/schemas/`
Expected: PASS

### Step 7: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 8: Commit

```bash
git add apps/api/src/middleware/validate.ts apps/api/src/schemas/pagination.ts apps/api/tests/unit/middleware/validate.test.ts apps/api/tests/unit/schemas/pagination.test.ts
git commit -m "feat(api): add request validation middleware and pagination schema"
```

---

## Task 6: Job Routes — CRUD & Lifecycle

Implement all job-related endpoints: create, list, get, update lifecycle (start, pause, resume, cancel, trigger reconciliation), and delete.

**Files:**
- Create: `apps/api/src/routes/jobs.ts`
- Create: `apps/api/src/schemas/job.ts`
- Test: `apps/api/tests/unit/routes/jobs.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jobRoutes } from '../../../src/routes/jobs.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      create: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', status: 'pending' }),
      findById: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', status: 'pending', tenantId: 'tenant-1' }),
      findByTenant: vi.fn().mockResolvedValue([{ id: 'job-1', name: 'Test', status: 'pending' }]),
      updateStatus: vi.fn().mockResolvedValue({ id: 'job-1', status: 'cancelled' }),
      updateStats: vi.fn().mockResolvedValue(null),
    },
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn().mockResolvedValue(undefined),
      pauseJob: vi.fn().mockResolvedValue(undefined),
      resumeJob: vi.fn().mockResolvedValue(undefined),
      cancelJob: vi.fn().mockResolvedValue(undefined),
      triggerReconciliation: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  // Inject deps and tenantId
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs', jobRoutes());
  return app;
}

describe('Job routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('POST /api/v1/jobs', () => {
    it('creates a job and returns 201', async () => {
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Job',
          description: 'A test',
          seedUrls: ['https://example.com'],
          crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
          schema: { mode: 'discovery' },
          llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe('job-1');
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/jobs', () => {
    it('returns list of jobs', async () => {
      const res = await app.request('/api/v1/jobs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /api/v1/jobs/:id', () => {
    it('returns job details', async () => {
      const res = await app.request('/api/v1/jobs/job-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('job-1');
    });

    it('returns 404 for missing job', async () => {
      (deps.jobRepo.findById as any).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/missing');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/jobs/:id/start', () => {
    it('starts a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/start', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', 'tenant-1');
    });
  });

  describe('POST /api/v1/jobs/:id/pause', () => {
    it('pauses a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/pause', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(deps.jobManager.pauseJob).toHaveBeenCalledWith('job-1', 'tenant-1');
    });
  });

  describe('POST /api/v1/jobs/:id/resume', () => {
    it('resumes a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/resume', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(deps.jobManager.resumeJob).toHaveBeenCalledWith('job-1', 'tenant-1');
    });
  });

  describe('POST /api/v1/jobs/:id/cancel', () => {
    it('cancels a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/cancel', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(deps.jobManager.cancelJob).toHaveBeenCalledWith('job-1', 'tenant-1');
    });
  });

  describe('POST /api/v1/jobs/:id/reconcile', () => {
    it('triggers reconciliation', async () => {
      const res = await app.request('/api/v1/jobs/job-1/reconcile', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(deps.jobManager.triggerReconciliation).toHaveBeenCalledWith('job-1', 'tenant-1');
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/routes/jobs.test.ts`
Expected: FAIL — modules not found

### Step 3: Write job request/response schemas

Create `apps/api/src/schemas/job.ts`:
```typescript
import { z } from 'zod';

export const createJobSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1),
  seedUrls: z.array(z.string().url()).min(1),
  crawl: z.object({
    maxDepth: z.number().int().min(0).max(10).default(2),
    maxPages: z.number().int().min(1).default(1000),
    concurrency: z.number().int().min(1).max(20).default(5),
    crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
  }),
  schema: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']),
    userFields: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
          required: z.boolean().default(false),
        }),
      )
      .optional(),
    evolutionConfig: z
      .object({
        enabled: z.boolean().default(true),
        batchSize: z.number().int().min(1).default(10),
        maxFields: z.number().int().min(1).default(50),
      })
      .optional(),
  }),
  llm: z.object({
    primaryModel: z.string().min(1).default('anthropic/claude-sonnet-4-20250514'),
    modelOverrides: z.record(z.string()).optional(),
  }),
  reconciliation: z
    .object({
      matchStrategy: z
        .enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted'])
        .default('fuzzy_name'),
      conflictResolution: z
        .enum(['most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved'])
        .default('most_common'),
      sourcePriority: z.array(z.string()).optional(),
      fuzzyMatchThreshold: z.number().min(0).max(1).default(0.85),
      enableLLMMatching: z.boolean().default(true),
    })
    .optional(),
});

export type CreateJobBody = z.infer<typeof createJobSchema>;

export const listJobsQuerySchema = z.object({
  status: z
    .enum(['pending', 'queued', 'running', 'paused', 'reconciling', 'completed', 'failed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
```

### Step 4: Write job routes

Create `apps/api/src/routes/jobs.ts`:
```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { createJobSchema, listJobsQuerySchema } from '../schemas/job.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function jobRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST / — Create job
  router.post('/', validateBody(createJobSchema), async (c) => {
    const body = c.get('validatedBody');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const config = { tenantId, ...body };
    const jobId = await deps.jobManager.createJob(config);
    const job = await deps.jobRepo.findById(jobId, tenantId);

    return c.json({ data: job }, 201);
  });

  // GET / — List jobs
  router.get('/', validateQuery(listJobsQuerySchema), async (c) => {
    const query = c.get('validatedQuery');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit,
    });

    return c.json({ data: jobs });
  });

  // GET /:id — Get job details
  router.get('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new NotFoundError('Job', jobId);
    }

    return c.json({ data: job });
  });

  // POST /:id/start — Start job
  router.post('/:id/start', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobManager.startJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job started' } });
  });

  // POST /:id/pause — Pause job
  router.post('/:id/pause', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobManager.pauseJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job paused' } });
  });

  // POST /:id/resume — Resume job
  router.post('/:id/resume', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobManager.resumeJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job resumed' } });
  });

  // POST /:id/cancel — Cancel job
  router.post('/:id/cancel', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobManager.cancelJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job cancelled' } });
  });

  // POST /:id/reconcile — Trigger reconciliation
  router.post('/:id/reconcile', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    await deps.jobManager.triggerReconciliation(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Reconciliation triggered' } });
  });

  return router;
}
```

### Step 5: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/routes/jobs.test.ts`
Expected: PASS

### Step 6: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 7: Commit

```bash
git add apps/api/src/routes/jobs.ts apps/api/src/schemas/job.ts apps/api/tests/unit/routes/jobs.test.ts
git commit -m "feat(api): add job CRUD and lifecycle routes"
```

---

## Task 7: Schema Routes

Implement endpoints for reading schema versions: current schema, all versions, and specific version.

**Files:**
- Create: `apps/api/src/routes/schemas.ts`
- Test: `apps/api/tests/unit/routes/schemas.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { schemaRoutes } from '../../../src/routes/schemas.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 3,
        definition: { version: 3, fields: [] },
      }),
      findAllVersions: vi.fn().mockResolvedValue([
        { id: 'schema-1', version: 1 },
        { id: 'schema-2', version: 2 },
        { id: 'schema-3', version: 3 },
      ]),
      findByVersion: vi.fn().mockResolvedValue({
        id: 'schema-2',
        version: 2,
        definition: { version: 2, fields: [] },
      }),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' }),
    },
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  return app;
}

describe('Schema routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/schema', () => {
    it('returns current (latest) schema', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.version).toBe(3);
    });

    it('returns 404 when no schema exists', async () => {
      (deps.schemaRepo.findLatest as any).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/job-1/schema');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/jobs/:jobId/schema/versions', () => {
    it('returns all schema versions', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(3);
    });
  });

  describe('GET /api/v1/jobs/:jobId/schema/versions/:version', () => {
    it('returns specific schema version', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.version).toBe(2);
    });

    it('returns 404 for missing version', async () => {
      (deps.schemaRepo.findByVersion as any).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/99');
      expect(res.status).toBe(404);
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/routes/schemas.test.ts`
Expected: FAIL

### Step 3: Write schema routes

Create `apps/api/src/routes/schemas.ts`:
```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function schemaRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — Get current (latest) schema for a job
  router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');

    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schema) {
      throw new NotFoundError('Schema', jobId);
    }

    return c.json({ data: schema });
  });

  // GET /versions — Get all schema versions
  router.get('/versions', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');

    const versions = await deps.schemaRepo.findAllVersions(jobId, tenantId);
    return c.json({ data: versions });
  });

  // GET /versions/:version — Get specific schema version
  router.get('/versions/:version', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');
    const version = parseInt(c.req.param('version'), 10);

    if (isNaN(version) || version < 1) {
      throw new (await import('@spatula/shared')).ValidationError('Version must be a positive integer');
    }

    const schema = await deps.schemaRepo.findByVersion(jobId, tenantId, version);
    if (!schema) {
      throw new NotFoundError('Schema version', String(version));
    }

    return c.json({ data: schema });
  });

  return router;
}
```

### Step 4: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/routes/schemas.test.ts`
Expected: PASS

### Step 5: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 6: Commit

```bash
git add apps/api/src/routes/schemas.ts apps/api/tests/unit/routes/schemas.test.ts
git commit -m "feat(api): add schema version routes"
```

---

## Task 8: Extraction & Entity Routes

Implement endpoints for listing extractions and entities with pagination, plus entity detail with provenance.

**Files:**
- Create: `apps/api/src/routes/extractions.ts`
- Create: `apps/api/src/routes/entities.ts`
- Test: `apps/api/tests/unit/routes/extractions.test.ts`
- Test: `apps/api/tests/unit/routes/entities.test.ts`

### Step 1: Write failing tests for extraction routes

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { extractionRoutes } from '../../../src/routes/extractions.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([
        { id: 'ext-1', data: { name: 'Product A' }, schemaVersion: 1 },
        { id: 'ext-2', data: { name: 'Product B' }, schemaVersion: 1 },
      ]),
    },
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  return app;
}

describe('Extraction routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/extractions', () => {
    it('returns extractions list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/extractions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('passes schema version filter', async () => {
      await app.request('/api/v1/jobs/job-1/extractions?schemaVersion=2');
      expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ schemaVersion: 2 }),
      );
    });

    it('passes limit parameter', async () => {
      await app.request('/api/v1/jobs/job-1/extractions?limit=10');
      expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ limit: 10 }),
      );
    });
  });
});
```

### Step 2: Write failing tests for entity routes

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { entityRoutes } from '../../../src/routes/entities.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
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
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([
        { extractionId: 'ext-1', matchConfidence: 0.9 },
      ]),
    },
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  return app;
}

describe('Entity routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/entities', () => {
    it('returns entities list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('passes pagination params', async () => {
      await app.request('/api/v1/jobs/job-1/entities?limit=10&offset=5');
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ limit: 10, offset: 5 }),
      );
    });
  });

  describe('GET /api/v1/jobs/:jobId/entities/:entityId', () => {
    it('returns entity with provenance and sources', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities/ent-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('ent-1');
      expect(body.data.sources).toHaveLength(1);
    });

    it('returns 404 for missing entity', async () => {
      (deps.entityRepo.findById as any).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/job-1/entities/missing');
      expect(res.status).toBe(404);
    });
  });
});
```

### Step 3: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/routes/extractions.test.ts tests/unit/routes/entities.test.ts`
Expected: FAIL

### Step 4: Write extraction routes

Create `apps/api/src/routes/extractions.ts`:
```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { validateQuery } from '../middleware/validate.js';

const listExtractionsQuery = z.object({
  schemaVersion: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function extractionRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — List extractions for a job
  router.get('/', validateQuery(listExtractionsQuery), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');
    const query = c.get('validatedQuery');

    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      schemaVersion: query.schemaVersion,
      limit: query.limit,
    });

    return c.json({ data: extractions });
  });

  return router;
}
```

### Step 5: Write entity routes

Create `apps/api/src/routes/entities.ts`:
```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import { validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function entityRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — List entities for a job
  router.get('/', validateQuery(paginationSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');
    const query = c.get('validatedQuery');

    const entities = await deps.entityRepo.findByJob(jobId, tenantId, {
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: entities });
  });

  // GET /:entityId — Get entity with full provenance
  router.get('/:entityId', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const entityId = c.req.param('entityId');

    const entity = await deps.entityRepo.findById(entityId, tenantId);
    if (!entity) {
      throw new NotFoundError('Entity', entityId);
    }

    const sources = await deps.entitySourceRepo.findByEntity(entityId);

    return c.json({
      data: {
        ...entity,
        sources,
      },
    });
  });

  return router;
}
```

### Step 6: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/routes/extractions.test.ts tests/unit/routes/entities.test.ts`
Expected: PASS

### Step 7: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 8: Commit

```bash
git add apps/api/src/routes/extractions.ts apps/api/src/routes/entities.ts apps/api/tests/unit/routes/extractions.test.ts apps/api/tests/unit/routes/entities.test.ts
git commit -m "feat(api): add extraction and entity routes with pagination"
```

---

## Task 9: Action Routes — List, Approve, Reject, Batch Approve

Implement action review workflow endpoints.

**Files:**
- Create: `apps/api/src/routes/actions.ts`
- Test: `apps/api/tests/unit/routes/actions.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { actionRoutes } from '../../../src/routes/actions.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([
        { id: 'act-1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
      ]),
      findById: vi.fn().mockResolvedValue({
        id: 'act-1',
        type: 'add_field',
        status: 'pending_review',
        confidence: 0.9,
        tenantId: 'tenant-1',
      }),
      updateStatus: vi.fn().mockResolvedValue({
        id: 'act-1',
        status: 'approved',
      }),
      batchUpdateStatus: vi.fn().mockResolvedValue([
        { id: 'act-1', status: 'approved' },
        { id: 'act-2', status: 'approved' },
      ]),
    },
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  return app;
}

describe('Action routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/actions', () => {
    it('returns actions list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('passes type and status filters', async () => {
      await app.request('/api/v1/jobs/job-1/actions?type=add_field&status=pending_review');
      expect(deps.actionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ type: 'add_field', status: 'pending_review' }),
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/:actionId/approve', () => {
    it('approves an action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'approved',
        undefined,
      );
    });

    it('passes reviewedBy from body', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'user-1' }),
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'approved',
        'user-1',
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/:actionId/reject', () => {
    it('rejects an action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/reject', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'rejected',
        undefined,
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/approve-all', () => {
    it('batch approves pending actions', async () => {
      (deps.actionRepo.findByJob as any).mockResolvedValue([
        { id: 'act-1', status: 'pending_review' },
        { id: 'act-2', status: 'pending_review' },
      ]);

      const res = await app.request('/api/v1/jobs/job-1/actions/approve-all', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.batchUpdateStatus).toHaveBeenCalledWith(
        ['act-1', 'act-2'],
        'tenant-1',
        'approved',
        undefined,
      );
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/routes/actions.test.ts`
Expected: FAIL

### Step 3: Write action routes

Create `apps/api/src/routes/actions.ts`:
```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { validateQuery } from '../middleware/validate.js';

const listActionsQuery = z.object({
  type: z.string().optional(),
  status: z
    .enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function actionRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — List actions for a job
  router.get('/', validateQuery(listActionsQuery), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');
    const query = c.get('validatedQuery');

    const actions = await deps.actionRepo.findByJob(jobId, tenantId, {
      type: query.type,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: actions });
  });

  // POST /:actionId/approve — Approve a single action
  router.post('/:actionId/approve', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const actionId = c.req.param('actionId');

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'approved', reviewedBy);
    return c.json({ data: action });
  });

  // POST /:actionId/reject — Reject a single action
  router.post('/:actionId/reject', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const actionId = c.req.param('actionId');

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'rejected', reviewedBy);
    return c.json({ data: action });
  });

  // POST /approve-all — Batch approve all pending actions
  router.post('/approve-all', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId');

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    // Find all pending actions
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

  return router;
}
```

### Step 4: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/routes/actions.test.ts`
Expected: PASS

### Step 5: Run build

Run: `cd apps/api && pnpm build`
Expected: Success

### Step 6: Commit

```bash
git add apps/api/src/routes/actions.ts apps/api/tests/unit/routes/actions.test.ts
git commit -m "feat(api): add action review workflow routes (approve, reject, batch)"
```

---

## Task 10: Route Registration & Server Entry Point

Wire all routes into the app factory, add middleware ordering, and create the server entry point.

**Files:**
- Modify: `apps/api/src/app.ts` (add route registration)
- Create: `apps/api/src/server.ts` (Hono node server)
- Modify: `apps/api/src/index.ts` (export app + start server)
- Test: `apps/api/tests/unit/app.test.ts`

### Step 1: Write failing tests for full app integration

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      findById: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', tenantId: 'tenant-1' }),
      findByTenant: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(null),
      findAllVersions: vi.fn().mockResolvedValue([]),
      findByVersion: vi.fn().mockResolvedValue(null),
    },
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    taskRepo: {},
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
  } as unknown as AppDeps;
}

describe('Full app', () => {
  it('health check works without tenant header', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('returns 400 when tenant header missing on API routes', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs');
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/jobs works with tenant header', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/jobs/:id/schema returns 404 when no schema', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/schema', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/jobs/:id/extractions returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/extractions', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('GET /api/v1/jobs/:id/entities returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/entities', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/jobs/:id/actions returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/actions', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/app.test.ts`
Expected: FAIL — `createApp` doesn't accept deps or register routes

### Step 3: Update app.ts to wire all routes

Update `apps/api/src/app.ts`:
```typescript
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { depsMiddleware } from './middleware/deps.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import type { AppDeps, AppEnv } from './types.js';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', honoLogger());
  app.onError(errorHandler);

  // Health check (before tenant middleware)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Tenant + deps injection for all API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));

  // API v1 routes
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());

  return app;
}
```

### Step 4: Create server entry point

Create `apps/api/src/server.ts`:
```typescript
import { serve } from '@hono/node-server';
import { createLogger } from '@spatula/shared';
import { createApp } from './app.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:server');

export function startServer(deps: AppDeps, port = 3000) {
  const app = createApp(deps);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  logger.info({ port }, 'API server started');
  return server;
}
```

### Step 5: Update index.ts entry point

Update `apps/api/src/index.ts`:
```typescript
export { createApp } from './app.js';
export { startServer } from './server.js';
export type { AppDeps, AppEnv } from './types.js';
```

### Step 6: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/app.test.ts`
Expected: PASS

### Step 7: Run full test suite + build

Run: `cd apps/api && pnpm vitest run && pnpm build`
Expected: All pass, build succeeds

### Step 8: Commit

```bash
git add apps/api/src/app.ts apps/api/src/server.ts apps/api/src/index.ts apps/api/tests/unit/app.test.ts
git commit -m "feat(api): wire all routes, add server entry point and integration tests"
```

---

## Task 11: Export & Documentation Stub Routes

Add stub endpoints for export and documentation (Phase 10 will implement the logic). This ensures the full API surface from the design doc is defined.

**Files:**
- Create: `apps/api/src/routes/exports.ts`
- Test: `apps/api/tests/unit/routes/exports.test.ts`

### Step 1: Write failing tests

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { exportRoutes } from '../../../src/routes/exports.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', {} as AppDeps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId', exportRoutes());
  return app;
}

describe('Export & documentation stub routes', () => {
  it('POST /export returns 501 not implemented', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/export', { method: 'POST' });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.message).toContain('Phase 10');
  });

  it('GET /export/:exportId returns 501 not implemented', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/export/exp-1');
    expect(res.status).toBe(501);
  });

  it('GET /documentation returns 501 not implemented', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/documentation');
    expect(res.status).toBe(501);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd apps/api && pnpm vitest run tests/unit/routes/exports.test.ts`
Expected: FAIL

### Step 3: Write stub routes

Create `apps/api/src/routes/exports.ts`:
```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function exportRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /export — Trigger export (Phase 10)
  router.post('/export', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Export will be implemented in Phase 10' } },
      501 as any,
    );
  });

  // GET /export/:exportId — Download export (Phase 10)
  router.get('/export/:exportId', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Export download will be implemented in Phase 10' } },
      501 as any,
    );
  });

  // GET /documentation — Auto-generated data dictionary (Phase 10)
  router.get('/documentation', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Documentation will be implemented in Phase 10' } },
      501 as any,
    );
  });

  return router;
}
```

### Step 4: Register in app.ts

Add to `apps/api/src/app.ts` imports:
```typescript
import { exportRoutes } from './routes/exports.js';
```

Add route registration (after action routes):
```typescript
app.route('/api/v1/jobs/:jobId', exportRoutes());
```

### Step 5: Run tests to verify they pass

Run: `cd apps/api && pnpm vitest run tests/unit/routes/exports.test.ts`
Expected: PASS

### Step 6: Run full suite + build

Run: `cd apps/api && pnpm vitest run && pnpm build`
Expected: All pass

### Step 7: Commit

```bash
git add apps/api/src/routes/exports.ts apps/api/src/app.ts apps/api/tests/unit/routes/exports.test.ts
git commit -m "feat(api): add export and documentation stub routes (Phase 10 placeholders)"
```

---

## Task 12: Full Build Verification & Barrel Exports

Final verification: ensure all packages build clean, all tests pass across the monorepo, and the API package exports are complete.

**Files:**
- Verify: `apps/api/src/index.ts` (all public exports)
- Verify: `packages/db/src/index.ts` (ActionRepository export)

### Step 1: Run full monorepo build

Run: `pnpm -r build`
Expected: All packages build successfully

### Step 2: Run full monorepo tests

Run: `pnpm -r test`
Expected: All tests pass

### Step 3: Run formatting check

Run: `pnpm -r lint`
Expected: No errors (fix any that appear)

### Step 4: Verify API exports are complete

Read `apps/api/src/index.ts` and ensure it exports:
- `createApp` — app factory
- `startServer` — server launcher
- `AppDeps`, `AppEnv` types

### Step 5: Commit final state

```bash
git add -A
git commit -m "chore(api): phase 8 final build verification and cleanup"
```

---

## Summary of Endpoints Implemented

| Method | Path | Task | Description |
|--------|------|------|-------------|
| GET | `/health` | 3 | Health check |
| POST | `/api/v1/jobs` | 6 | Create job |
| GET | `/api/v1/jobs` | 6 | List jobs |
| GET | `/api/v1/jobs/:id` | 6 | Get job details |
| POST | `/api/v1/jobs/:id/start` | 6 | Start job |
| POST | `/api/v1/jobs/:id/pause` | 6 | Pause job |
| POST | `/api/v1/jobs/:id/resume` | 6 | Resume job |
| POST | `/api/v1/jobs/:id/cancel` | 6 | Cancel job |
| POST | `/api/v1/jobs/:id/reconcile` | 6 | Trigger reconciliation |
| GET | `/api/v1/jobs/:id/schema` | 7 | Get current schema |
| GET | `/api/v1/jobs/:id/schema/versions` | 7 | List schema versions |
| GET | `/api/v1/jobs/:id/schema/versions/:v` | 7 | Get specific version |
| GET | `/api/v1/jobs/:id/extractions` | 8 | List extractions |
| GET | `/api/v1/jobs/:id/entities` | 8 | List entities |
| GET | `/api/v1/jobs/:id/entities/:eid` | 8 | Entity detail + provenance |
| GET | `/api/v1/jobs/:id/actions` | 9 | List actions |
| POST | `/api/v1/jobs/:id/actions/:aid/approve` | 9 | Approve action |
| POST | `/api/v1/jobs/:id/actions/:aid/reject` | 9 | Reject action |
| POST | `/api/v1/jobs/:id/actions/approve-all` | 9 | Batch approve |
| POST | `/api/v1/jobs/:id/export` | 11 | Export (stub) |
| GET | `/api/v1/jobs/:id/export/:eid` | 11 | Download export (stub) |
| GET | `/api/v1/jobs/:id/documentation` | 11 | Data dictionary (stub) |

## Files Created/Modified

**New files (API):**
- `apps/api/vitest.config.ts`
- `apps/api/src/types.ts`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/middleware/error-handler.ts`
- `apps/api/src/middleware/tenant.ts`
- `apps/api/src/middleware/deps.ts`
- `apps/api/src/middleware/validate.ts`
- `apps/api/src/schemas/pagination.ts`
- `apps/api/src/schemas/job.ts`
- `apps/api/src/routes/jobs.ts`
- `apps/api/src/routes/schemas.ts`
- `apps/api/src/routes/extractions.ts`
- `apps/api/src/routes/entities.ts`
- `apps/api/src/routes/actions.ts`
- `apps/api/src/routes/exports.ts`
- 10 test files in `apps/api/tests/unit/`

**New files (DB):**
- `packages/db/src/repositories/action-repository.ts`
- `packages/db/tests/unit/repositories/action-repository.test.ts`

**Modified files:**
- `apps/api/package.json` (deps + scripts)
- `apps/api/src/index.ts` (exports)
- `packages/db/src/repositories/index.ts` (ActionRepository export)
