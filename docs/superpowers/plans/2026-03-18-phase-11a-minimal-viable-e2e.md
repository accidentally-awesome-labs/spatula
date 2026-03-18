# Phase 11a: Minimal Viable E2E — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a complete Spatula job end-to-end against real Postgres + Redis — create job, crawl, extract, evolve schema, reconcile, export.

**Architecture:** Fix the schemas FK, generate Drizzle migrations, add docker-compose for local infra, add `ActionRepository.create()` for audit persistence, add a Redis distributed lock to schema evolution, configure queue concurrency/rate limits, and write an E2E integration test that validates the full pipeline with mocked LLM.

**Tech Stack:** Drizzle ORM, PostgreSQL 16, Redis 7, BullMQ, Docker Compose, Vitest, ioredis

---

## Prerequisites

- Phases 1–10 complete
- pnpm, Docker, Node.js >= 18 available locally
- Design spec: `docs/superpowers/specs/2026-03-17-phase-11-production-hardening-design.md`

## File Map

```
Modified:
  packages/db/src/schema/schemas.ts           — Add jobId FK reference
  packages/db/src/repositories/action-repository.ts — Add create() method
  packages/db/src/repositories/index.ts       — Export CreateActionInput type
  packages/db/package.json                    — Add db:generate and db:migrate scripts
  packages/queue/src/queues.ts                — Add QueueConfig, defaultJobOptions, config return
  packages/queue/src/worker-deps.ts           — Add actionRepo dependency
  packages/queue/src/workers/schema-worker.ts — Add distributed lock + action persistence
  packages/queue/src/index.ts                 — Export QueueConfig type and redis-lock

Created:
  docker-compose.yml                          — Postgres 16 + Redis 7
  scripts/init-test-db.sql                    — Creates spatula_test database on init
  .env                                        — Local dev defaults (gitignored)
  packages/db/drizzle/                        — Generated migration SQL (via drizzle-kit)
  packages/db/src/run-migrate.ts              — Migration runner entry point
  packages/queue/src/redis-lock.ts            — Distributed lock utility
  tests/e2e/vitest.config.ts                  — Vitest config for E2E tests
  tests/e2e/fixtures/product-page.html        — HTML fixture for crawl targets
  tests/e2e/full-pipeline.test.ts             — End-to-end integration test

Test files (new or modified):
  packages/db/tests/unit/schema/tables.test.ts          — Add FK assertion
  packages/db/tests/unit/repositories/action-repository.test.ts — Add create() tests
  packages/queue/tests/unit/queues.test.ts              — Add QueueConfig tests
  packages/queue/tests/unit/worker-deps.test.ts         — Add actionRepo assertion
  packages/queue/tests/unit/workers/schema-worker.test.ts — Add lock + action persistence tests
  packages/queue/tests/unit/redis-lock.test.ts          — Lock utility tests
```

---

## Task 1: Fix `schemas.jobId` Foreign Key

**Files:**
- Modify: `packages/db/src/schema/schemas.ts`
- Modify: `packages/db/tests/unit/schema/tables.test.ts`

- [ ] **Step 1: Write a failing test**

Add a test to `packages/db/tests/unit/schema/tables.test.ts` inside the existing describe block:

```typescript
it('schemasTable.jobId is defined and not null', () => {
  // The FK reference itself is validated by the generated migration SQL
  // and the E2E test — here we just verify the column exists and is not null.
  const jobIdCol = schemasTable.jobId;
  expect(jobIdCol).toBeDefined();
  expect(jobIdCol.notNull).toBe(true);
});
```

- [ ] **Step 2: Run the test to confirm baseline**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`

- [ ] **Step 3: Add the FK reference**

In `packages/db/src/schema/schemas.ts`, change line 10 from:

```typescript
jobId: uuid('job_id').notNull(),
```

to:

```typescript
jobId: uuid('job_id')
  .notNull()
  .references(() => jobs.id, { onDelete: 'cascade' }),
```

The `onDelete: 'cascade'` is needed so that deleting a job automatically deletes its schemas (Phase 11d). The reverse FK (`jobs.schemaId → schemas.id`) is already nullable and will be SET NULL before cascade.

Add the import at the top (after the tenants import):

```typescript
import { jobs } from './jobs.js';
```

**Circular import note:** `schemas.ts` imports `jobs.ts` and `jobs.ts` imports `schemas.ts` (for `schemasTable.id`). Drizzle handles this with lazy references — both files use `() =>` arrow functions in `.references()`, evaluated at runtime not import time. `drizzle-kit generate` handles circular FKs correctly.

- [ ] **Step 4: Run tests to verify**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/schemas.ts packages/db/tests/unit/schema/tables.test.ts
git commit -m "fix(db): add missing FK reference from schemas.jobId to jobs.id"
```

---

## Task 2: Docker Compose + Environment

**Files:**
- Create: `docker-compose.yml`
- Create: `scripts/init-test-db.sql`
- Create: `.env`

- [ ] **Step 1: Create docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: spatula
      POSTGRES_PASSWORD: spatula
      POSTGRES_DB: spatula
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spatula"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 2: Create the test DB init script**

Create `scripts/init-test-db.sql`:

```sql
SELECT 'CREATE DATABASE spatula_test OWNER spatula'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'spatula_test')\gexec
```

- [ ] **Step 3: Create .env from .env.example**

Create `.env`:

```
# OpenRouter
OPENROUTER_API_KEY=

# Database
DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula

# Redis
REDIS_URL=redis://localhost:6379

# Firecrawl (optional)
FIRECRAWL_API_KEY=

# Test database
TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test
```

- [ ] **Step 4: Add .env to .gitignore if not already there**

Check `.gitignore` for `.env`. If absent, add the line `.env` (but NOT `.env.example`).

- [ ] **Step 5: Update .env.example with TEST_DATABASE_URL**

Add to `.env.example`:

```
# Test database
TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test
```

- [ ] **Step 6: Verify Docker Compose starts**

Run: `docker compose up -d`
Run: `docker compose ps` — both services should show "healthy"
Run: `docker compose down`

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml scripts/init-test-db.sql .env.example .gitignore
git commit -m "infra: add docker-compose with Postgres 16 and Redis 7 for local dev"
```

Note: `.env` is NOT committed (it's gitignored). Only `.env.example` is tracked.

---

## Task 3: Generate Drizzle Migrations + DB Scripts

**Files:**
- Modify: `packages/db/package.json`
- Create: `packages/db/src/run-migrate.ts`
- Create: `packages/db/drizzle/` (generated)

- [ ] **Step 1: Add migration scripts to package.json**

In `packages/db/package.json`, add to the `scripts` section:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx src/run-migrate.ts"
```

- [ ] **Step 2: Create the migration runner entry point**

Create `packages/db/src/run-migrate.ts`:

```typescript
import { runMigrations } from './migrate.js';

runMigrations()
  .then(() => {
    console.log('Migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
```

- [ ] **Step 3: Add tsx as a dev dependency**

Run: `cd /Users/salar/Projects/spatula/packages/db && pnpm add -D tsx`

- [ ] **Step 4: Start Docker and generate migrations**

Run: `docker compose up -d`
Run: `cd /Users/salar/Projects/spatula/packages/db && pnpm db:generate`

This creates SQL files in `packages/db/drizzle/`. Inspect the generated SQL to verify it includes:
- All 12 tables (tenants, jobs, schemas, crawl_tasks, raw_pages, extractions, entities, entity_sources, actions, source_trust, content_store, exports)
- The new `schemas.job_id` FK to `jobs.id`
- All enum types
- All indexes

- [ ] **Step 5: Run the migrations against local Postgres**

Run: `cd /Users/salar/Projects/spatula/packages/db && DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula pnpm db:migrate`
Expected: "Migrations complete"

- [ ] **Step 6: Verify tables exist**

Run: `docker compose exec postgres psql -U spatula -c '\dt'`
Expected: All 12 tables listed.

- [ ] **Step 7: Commit**

```bash
git add packages/db/package.json packages/db/src/run-migrate.ts packages/db/drizzle/
git commit -m "feat(db): generate Drizzle migrations and add db:generate/db:migrate scripts"
```

---

## Task 4: Add `ActionRepository.create()`

**Files:**
- Modify: `packages/db/src/repositories/action-repository.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Modify: `packages/db/tests/unit/repositories/action-repository.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/db/tests/unit/repositories/action-repository.test.ts`, inside the existing `describe('ActionRepository', ...)` block:

```typescript
it('create inserts an action and returns the id', async () => {
  const insertChainable = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'new-action-id' }]),
  };
  mockDb.insert = vi.fn().mockReturnValue(insertChainable);

  const result = await repo.create({
    jobId: '550e8400-e29b-41d4-a716-446655440000',
    tenantId: '550e8400-e29b-41d4-a716-446655440001',
    type: 'add_field',
    payload: { field: { name: 'price' } },
    source: 'schema_evolution',
    status: 'applied',
    confidence: 0.9,
    reasoning: 'Price field found in multiple extractions',
  });

  expect(mockDb.insert).toHaveBeenCalled();
  expect(result).toEqual({ id: 'new-action-id' });
});

it('create wraps errors in StorageError', async () => {
  const failChainable = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockRejectedValue(new Error('db error')),
  };
  mockDb.insert = vi.fn().mockReturnValue(failChainable);

  await expect(
    repo.create({
      jobId: 'job-id',
      tenantId: 'tenant-id',
      type: 'add_field',
      payload: {},
      source: 'schema_evolution',
      status: 'applied',
      confidence: 0.9,
      reasoning: 'test',
    }),
  ).rejects.toThrow('Failed to create action');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`
Expected: FAIL — `repo.create is not a function`

- [ ] **Step 3: Implement `create()` method**

Add the `CreateActionInput` interface to `packages/db/src/repositories/action-repository.ts` after the existing `FindActionsOptions` interface:

```typescript
export interface CreateActionInput {
  jobId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  source: string;
  status: string;
  confidence: number;
  reasoning: string;
  stateChanges?: Record<string, unknown>;
}
```

Then add the `create` method inside the `ActionRepository` class, before `findByJob`:

```typescript
async create(input: CreateActionInput): Promise<{ id: string }> {
  try {
    const [row] = await this.db
      .insert(actions)
      .values({
        jobId: input.jobId,
        tenantId: input.tenantId,
        type: input.type,
        payload: input.payload,
        source: input.source as any,
        status: (input.status as any) ?? 'pending_review',
        confidence: input.confidence,
        reasoning: input.reasoning,
        stateChanges: input.stateChanges ?? null,
      })
      .returning({ id: actions.id });

    logger.debug({ actionId: row.id, type: input.type }, 'action created');
    return { id: row.id };
  } catch (error) {
    throw new StorageError(`Failed to create action: ${(error as Error).message}`, {
      cause: error as Error,
      context: { jobId: input.jobId, type: input.type },
    });
  }
}
```

- [ ] **Step 4: Export `CreateActionInput` from the repository barrel**

In `packages/db/src/repositories/index.ts`, update the ActionRepository export line:

```typescript
export { ActionRepository } from './action-repository.js';
export type { ActionStatus, FindActionsOptions, CreateActionInput } from './action-repository.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/action-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/action-repository.test.ts
git commit -m "feat(db): add ActionRepository.create() for action audit trail persistence"
```

---

## Task 5: Add `actionRepo` to WorkerDeps

**Files:**
- Modify: `packages/queue/src/worker-deps.ts`
- Modify: `packages/queue/tests/unit/worker-deps.test.ts`
- Modify: `packages/queue/tests/unit/workers/schema-worker.test.ts`

- [ ] **Step 1: Update the test first**

In `packages/queue/tests/unit/worker-deps.test.ts`, the existing test mock is missing `exportRepo` — add both `exportRepo` and `actionRepo` to the constructor call:

```typescript
exportRepo: {} as any,
actionRepo: {} as any,
```

And add assertions for both:

```typescript
expect(deps.exportRepo).toBeDefined();
expect(deps.actionRepo).toBeDefined();
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: FAIL — TypeScript or runtime error about `actionRepo`

- [ ] **Step 3: Add `actionRepo` to WorkerDeps**

In `packages/queue/src/worker-deps.ts`:

Add `ActionRepository` to the import from `@spatula/db`:
```typescript
ActionRepository,
```

Add to `WorkerDepsConfig` interface (after `exportRepo`):
```typescript
actionRepo: ActionRepository;
```

Add to `WorkerDeps` class readonly fields (after `readonly exportRepo`):
```typescript
readonly actionRepo: ActionRepository;
```

Add to the constructor (after `this.exportRepo = config.exportRepo;`):
```typescript
this.actionRepo = config.actionRepo;
```

- [ ] **Step 4: Update the schema-worker test's `createMockDeps` helper**

In `packages/queue/tests/unit/workers/schema-worker.test.ts`, add to `createMockDeps()` return object:

```typescript
actionRepo: {
  create: vi.fn().mockResolvedValue({ id: 'action-1' }),
  findByJob: vi.fn().mockResolvedValue([]),
  findById: vi.fn().mockResolvedValue(null),
  updateStatus: vi.fn().mockResolvedValue(null),
  batchUpdateStatus: vi.fn().mockResolvedValue([]),
} as any,
```

- [ ] **Step 5: Run all queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/worker-deps.ts packages/queue/tests/unit/worker-deps.test.ts packages/queue/tests/unit/workers/schema-worker.test.ts
git commit -m "feat(queue): add actionRepo to WorkerDeps for action audit trail"
```

---

## Task 6: Redis Distributed Lock

**Files:**
- Create: `packages/queue/src/redis-lock.ts`
- Create: `packages/queue/tests/unit/redis-lock.test.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/queue/tests/unit/redis-lock.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireLock, releaseLock } from '../../src/redis-lock.js';

function createMockRedis() {
  return {
    set: vi.fn(),
    call: vi.fn(),
  };
}

describe('Redis Distributed Lock', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  describe('acquireLock', () => {
    it('returns acquired=true and a token when SET NX succeeds', async () => {
      redis.set.mockResolvedValue('OK');

      const result = await acquireLock(redis as any, 'test-lock', 30);

      expect(result.acquired).toBe(true);
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
      expect(redis.set).toHaveBeenCalledWith(
        'test-lock',
        expect.any(String),
        'EX',
        30,
        'NX',
      );
    });

    it('returns acquired=false when SET NX fails (lock held)', async () => {
      redis.set.mockResolvedValue(null);

      const result = await acquireLock(redis as any, 'test-lock', 30);

      expect(result.acquired).toBe(false);
      expect(result.token).toBe('');
    });
  });

  describe('releaseLock', () => {
    it('calls Redis EVAL with Lua CAS script', async () => {
      redis.call.mockResolvedValue(1);

      await releaseLock(redis as any, 'test-lock', 'my-token');

      expect(redis.call).toHaveBeenCalledWith(
        'EVAL',
        expect.stringContaining('redis.call'),
        '1',
        'test-lock',
        'my-token',
      );
    });

    it('does not throw when key does not exist', async () => {
      redis.call.mockResolvedValue(0);

      await expect(
        releaseLock(redis as any, 'test-lock', 'wrong-token'),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: FAIL — cannot resolve `../../src/redis-lock.js`

- [ ] **Step 3: Implement the lock utility**

Create `packages/queue/src/redis-lock.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function acquireLock(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<{ acquired: boolean; token: string }> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');

  if (result === 'OK') {
    return { acquired: true, token };
  }

  return { acquired: false, token: '' };
}

export async function releaseLock(
  redis: Redis,
  key: string,
  token: string,
): Promise<void> {
  await redis.call('EVAL', RELEASE_SCRIPT, '1', key, token);
}
```

- [ ] **Step 4: Export from package index**

Add to `packages/queue/src/index.ts`:

```typescript
// Redis Lock
export { acquireLock, releaseLock } from './redis-lock.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/redis-lock.ts packages/queue/tests/unit/redis-lock.test.ts packages/queue/src/index.ts
git commit -m "feat(queue): add Redis distributed lock with token-based CAS release"
```

---

## Task 7: Add Distributed Lock to Schema Worker

**Files:**
- Modify: `packages/queue/src/workers/schema-worker.ts`
- Modify: `packages/queue/tests/unit/workers/schema-worker.test.ts`

- [ ] **Step 1: Write failing tests for lock behavior**

At the top of `packages/queue/tests/unit/workers/schema-worker.test.ts`, add the mock (before the existing imports of the worker):

```typescript
vi.mock('../../src/redis-lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 'test-token' }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { acquireLock, releaseLock } from '../../src/redis-lock.js';
```

Then add these test cases inside the existing describe block. **Important:** The lock path only runs when a `redis` argument is provided (3rd parameter). Existing tests pass 2 arguments and verify non-lock behavior. These new tests pass a mock Redis to exercise the lock path:

```typescript
const mockRedis = {} as any; // Lock functions are fully mocked, Redis object is not called directly

it('skips evolution when lock cannot be acquired', async () => {
  vi.mocked(acquireLock).mockResolvedValueOnce({ acquired: false, token: '' });

  await processSchemaEvolutionJob(createJobData(), deps, mockRedis);

  expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
});

it('releases lock after successful evolution', async () => {
  await processSchemaEvolutionJob(createJobData(), deps, mockRedis);

  expect(releaseLock).toHaveBeenCalledWith(
    mockRedis,
    'schema-lock:job-1',
    'test-token',
  );
});

it('releases lock even when evolution throws', async () => {
  (deps.schemaEvolver.evolve as any).mockRejectedValueOnce(new Error('LLM error'));

  await processSchemaEvolutionJob(createJobData(), deps, mockRedis);

  expect(releaseLock).toHaveBeenCalledWith(
    mockRedis,
    'schema-lock:job-1',
    'test-token',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: FAIL — lock functions not called by the worker

- [ ] **Step 3: Add lock to schema worker**

Modify `packages/queue/src/workers/schema-worker.ts`. Add imports at top:

```typescript
import type Redis from 'ioredis';
import { acquireLock, releaseLock } from '../redis-lock.js';
```

Change the function signature to accept an optional Redis connection:

```typescript
export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
  redis?: Redis,
): Promise<void> {
```

Restructure the function body to wrap with lock:

```typescript
const { jobId, tenantId } = data;
const lockKey = `schema-lock:${jobId}`;
let lockToken = '';

if (redis) {
  const lock = await acquireLock(redis, lockKey, 30);
  if (!lock.acquired) {
    logger.debug({ jobId }, 'could not acquire schema evolution lock, skipping');
    return;
  }
  lockToken = lock.token;
}

try {
  // ... all existing logic from "1. Load job config" through "9. Persist new schema version" ...
} catch (error) {
  logger.error({ jobId, error }, 'schema evolution job failed');
} finally {
  if (redis && lockToken) {
    await releaseLock(redis, lockKey, lockToken);
  }
}
```

The existing try/catch block becomes the inner content of the new try block. Remove the old standalone catch block since the new try/catch/finally replaces it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/workers/schema-worker.ts packages/queue/tests/unit/workers/schema-worker.test.ts
git commit -m "feat(queue): add distributed lock to schema evolution worker"
```

---

## Task 8: Add Action Persistence to Schema Worker

**Files:**
- Modify: `packages/queue/src/workers/schema-worker.ts`
- Modify: `packages/queue/tests/unit/workers/schema-worker.test.ts`

- [ ] **Step 1: Write failing test for action persistence**

Add to the schema-worker test:

```typescript
it('persists each action via actionRepo.create before applying', async () => {
  await processSchemaEvolutionJob(createJobData(), deps);

  expect(deps.actionRepo.create).toHaveBeenCalledWith(
    expect.objectContaining({
      jobId: 'job-1',
      tenantId: 'tenant-1',
      type: 'add_field',
      source: 'schema_evolution',
      status: 'applied',
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: FAIL — `actionRepo.create` not called

- [ ] **Step 3: Add action persistence to schema worker**

In `packages/queue/src/workers/schema-worker.ts`, after the line that stamps `jobId` on actions and before calling `applySchemaActions`, add:

```typescript
// 7b. Persist each action to the audit log
for (const action of actions) {
  await deps.actionRepo.create({
    jobId,
    tenantId,
    type: action.type,
    payload: 'payload' in action ? (action as any).payload : {},
    source: action.source ?? 'schema_evolution',
    status: 'applied',
    confidence: action.confidence,
    reasoning: action.reasoning,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/workers/schema-worker.ts packages/queue/tests/unit/workers/schema-worker.test.ts
git commit -m "feat(queue): persist schema evolution actions to audit log via ActionRepository"
```

---

## Task 9: Queue Concurrency & Rate Limiting

**Files:**
- Modify: `packages/queue/src/queues.ts`
- Modify: `packages/queue/tests/unit/queues.test.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/queue/tests/unit/queues.test.ts`:

```typescript
it('accepts QueueConfig and applies defaultJobOptions', () => {
  const config = {
    crawl: { concurrency: 5, rateLimitMax: 10, rateLimitDuration: 1000 },
    extract: { concurrency: 3 },
    schemaEvolution: { concurrency: 1 },
    reconciliation: { concurrency: 1 },
    export: { concurrency: 2 },
  };
  const result = createQueues({ host: 'localhost', port: 6379 }, config);
  expect(result.config).toEqual(config);
});

it('uses default config when none provided', () => {
  const result = createQueues({ host: 'localhost', port: 6379 });
  expect(result.config).toBeDefined();
  expect(result.config.crawl.concurrency).toBe(5);
  expect(result.config.schemaEvolution.concurrency).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: FAIL — `result.config` is undefined

- [ ] **Step 3: Implement QueueConfig**

In `packages/queue/src/queues.ts`, add the following after the `ExportJobPayload` interface:

```typescript
export interface QueueConfig {
  crawl: { concurrency: number; rateLimitMax: number; rateLimitDuration: number };
  extract: { concurrency: number };
  schemaEvolution: { concurrency: number };
  reconciliation: { concurrency: number };
  export: { concurrency: number };
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  crawl: { concurrency: 5, rateLimitMax: 10, rateLimitDuration: 1000 },
  extract: { concurrency: 3 },
  schemaEvolution: { concurrency: 1 },
  reconciliation: { concurrency: 1 },
  export: { concurrency: 2 },
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};
```

Add `config: QueueConfig` to the `SpatulaQueues` interface.

Change the `createQueues` signature to:

```typescript
export function createQueues(
  connection: ConnectionOptions,
  queueConfig?: QueueConfig,
): SpatulaQueues {
  const config = queueConfig ?? DEFAULT_QUEUE_CONFIG;
```

Update each `new Queue(...)` call to include `defaultJobOptions: DEFAULT_JOB_OPTIONS`.

Add `config` to the return object.

- [ ] **Step 4: Export QueueConfig from package index**

In `packages/queue/src/index.ts`, update the queues exports to include:

```typescript
export { createQueues, QUEUE_NAMES, DEFAULT_QUEUE_CONFIG } from './queues.js';
```

And add `QueueConfig` to the type exports.

- [ ] **Step 5: Run all queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/queues.ts packages/queue/tests/unit/queues.test.ts packages/queue/src/index.ts
git commit -m "feat(queue): add QueueConfig with concurrency, rate limiting, and retry defaults"
```

---

## Task 10: E2E Integration Test

**Files:**
- Create: `tests/e2e/vitest.config.ts`
- Create: `tests/e2e/fixtures/product-page.html`
- Create: `tests/e2e/full-pipeline.test.ts`
- Modify: `package.json` (root — add `test:e2e` script)

- [ ] **Step 1: Create vitest config for E2E**

Create `tests/e2e/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ['tests/e2e/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Add `test:e2e` script to root package.json**

Add to `package.json` scripts:

```json
"test:e2e": "vitest run --config tests/e2e/vitest.config.ts"
```

- [ ] **Step 3: Install E2E test dependencies at workspace root**

Run: `cd /Users/salar/Projects/spatula && pnpm add -D vitest ioredis`

- [ ] **Step 4: Create HTML fixture**

Create `tests/e2e/fixtures/product-page.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Test Product</title></head>
<body>
  <h1>Wireless Headphones XZ-500</h1>
  <span class="price">$149.99</span>
  <p class="description">Premium wireless headphones with active noise cancellation.</p>
  <span class="brand">AudioTech</span>
  <ul class="features">
    <li>Active Noise Cancellation</li>
    <li>40-hour battery life</li>
    <li>Bluetooth 5.3</li>
  </ul>
  <a href="/products/xz-600">Next Model: XZ-600</a>
</body>
</html>
```

- [ ] **Step 5: Write the E2E test**

Create `tests/e2e/full-pipeline.test.ts`. This is a large file — it creates mock implementations for the LLM-dependent interfaces (Crawler, Extractor, SchemaEvolver, Reconciler, PageClassifier), wires up real repositories against the test database, and runs the full pipeline:

1. Create tenant + job
2. Start job (creates schema v1, enqueues crawl tasks)
3. Process crawl job (fetches fixture page, classifies, extracts, stores)
4. Process schema evolution (evolves schema from extraction data)
5. Trigger + process reconciliation (creates entities with provenance)
6. Create + process export (generates JSON export)
7. Verify each step produced expected DB state
8. Cleanup test data in afterAll

The mock interfaces return deterministic fixture data so the test is repeatable. Real Postgres and Redis are used for storage and queuing.

See the full test code in the spec discussion — adapt based on actual repository method signatures discovered during implementation.

- [ ] **Step 6: Run the E2E test**

Ensure Docker is running:
```bash
docker compose up -d
```

Run E2E migrations against test DB:
```bash
TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test pnpm --filter @spatula/db db:migrate
```

Run E2E test:
```bash
TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test REDIS_URL=redis://localhost:6379 pnpm test:e2e
```
Expected: PASS — full pipeline completes.

- [ ] **Step 7: Fix any issues discovered during E2E**

The E2E test exercises real DB queries for the first time. Expect potential issues with:
- Column name mismatches between Drizzle schema and generated SQL
- Missing NOT NULL defaults
- FK constraint ordering on INSERT
- Type mismatches between mock return values and what repos expect

Debug and fix each issue as it surfaces.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/ package.json
git commit -m "test: add E2E integration test for full crawl pipeline against real Postgres + Redis"
```

---

## Task 11: Run Full Test Suite

- [ ] **Step 1: Run all unit tests across all packages**

```bash
cd /Users/salar/Projects/spatula && pnpm test
```
Expected: All tests pass.

- [ ] **Step 2: Run E2E test**

```bash
docker compose up -d && pnpm test:e2e
```
Expected: All tests pass.

- [ ] **Step 3: Run build**

```bash
cd /Users/salar/Projects/spatula && pnpm build
```
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Final commit if any stragglers**

```bash
git add -A && git status
```

If there are uncommitted changes, create a final cleanup commit.
