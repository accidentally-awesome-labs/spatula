# Wave 2.2c: Dead Letter Queue

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture permanently failed BullMQ jobs in a database table for post-mortem analysis, with admin API endpoints to list, retry, and discard failed jobs.

**Architecture:** When a BullMQ job exhausts all retry attempts, a `failed` event handler inserts the job data into a `dead_letter_queue` Postgres table. A `DlqRepository` provides CRUD operations. Admin API routes at `/api/v1/admin/dlq` allow operators to inspect failures, retry jobs (re-enqueue to the original queue), or discard them. The DLQ table uses `ON DELETE SET NULL` for FK references so job/tenant deletion doesn't cascade-block.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), BullMQ Worker events, Hono routes, Vitest

**Spec references:**

- Phase 12 spec: section 5.1 (Dead Letter Queue)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File                                                         | Responsibility              |
| ------------------------------------------------------------ | --------------------------- |
| `packages/db/src/schema/dead-letter-queue.ts`                | DLQ table schema            |
| `packages/db/src/repositories/dlq-repository.ts`             | DLQ CRUD operations         |
| `packages/queue/src/dlq-handler.ts`                          | BullMQ failed event handler |
| `apps/api/src/routes/admin-dlq.ts`                           | Admin DLQ API routes        |
| `packages/db/tests/unit/repositories/dlq-repository.test.ts` | DLQ repo tests              |
| `packages/queue/tests/unit/dlq-handler.test.ts`              | Failed handler tests        |
| `apps/api/tests/unit/routes/admin-dlq.test.ts`               | Admin route tests           |

### Modified Files

| File                                      | Change                            |
| ----------------------------------------- | --------------------------------- |
| `packages/db/src/schema/index.ts`         | Export DLQ table                  |
| `packages/db/src/repositories/index.ts`   | Export DlqRepository              |
| `packages/db/src/index.ts`                | Re-export DlqRepository           |
| `packages/queue/src/worker-entrypoint.ts` | Attach failed handlers to workers |
| `packages/queue/src/index.ts`             | Export DLQ handler                |
| `apps/api/src/app.ts`                     | Mount admin DLQ routes            |
| `apps/api/src/types.ts`                   | Add dlqRepo to AppDeps            |

---

## Task 1: DLQ Database Table

**Files:**

- Create: `packages/db/src/schema/dead-letter-queue.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create DLQ table schema**

```typescript
// packages/db/src/schema/dead-letter-queue.ts
import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { jobs } from './jobs.js';

export const deadLetterQueue = pgTable(
  'dead_letter_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueName: text('queue_name').notNull(),
    jobId: text('job_id').notNull(), // BullMQ job ID (string, not UUID)
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    spatulaJobId: uuid('spatula_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull(), // Full job data as JSONB (per spec 5.1.1)
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    attempts: integer('attempts').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'), // 'retried', 'discarded', 'fixed'
  },
  (table) => [
    // Regular index (not partial — Drizzle's index().where() support varies)
    index('dlq_queue_failed_idx').on(table.queueName, table.failedAt),
    index('dlq_tenant_idx').on(table.tenantId),
  ],
);
```

**Note on partial index:** Drizzle's `index().where()` support varies by version. If not available, use a regular index on `(queue_name, failed_at)` and filter `resolved_at IS NULL` in queries. The spec's `WHERE resolved_at IS NULL` partial index is a performance optimization, not a correctness requirement.

**Note on FK cascades:** Both `tenantId` and `spatulaJobId` use `ON DELETE SET NULL` so DLQ records survive job and tenant cleanup (per spec section 5.1.1).

- [ ] **Step 2: Export from schema barrel**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from './dead-letter-queue.js';
```

- [ ] **Step 3: Generate Postgres migration**

Run:

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db db:generate
```

This generates a new migration file in `packages/db/drizzle/` with the CREATE TABLE statement.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @spatula/db build`

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/dead-letter-queue.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): add dead_letter_queue table for failed job tracking"
```

---

## Task 2: DLQ Repository

**Files:**

- Create: `packages/db/src/repositories/dlq-repository.ts`
- Create: `packages/db/tests/unit/repositories/dlq-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/db/tests/unit/repositories/dlq-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DlqRepository } from '../../../src/repositories/dlq-repository.js';

/**
 * Mock DB that captures the arguments passed to each Drizzle method.
 * The chain pattern (select().from().where()...) returns `this` at each
 * step, so we can inspect which methods were called and with what args.
 */
function createMockDb() {
  const mock = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi
      .fn()
      .mockResolvedValue([
        { id: 'dlq-1', queueName: 'spatula.crawl', jobId: 'bullmq-123', resolvedAt: null },
      ]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('DlqRepository', () => {
  let db: ReturnType<typeof createMockDb>;
  let repo: DlqRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new DlqRepository(db as any);
  });

  it('insert passes all fields to Drizzle insert().values()', async () => {
    const input = {
      queueName: 'spatula.crawl',
      jobId: 'bullmq-job-123',
      tenantId: 'tenant-1',
      spatulaJobId: 'job-1',
      payload: { taskId: 'task-1', url: 'https://example.com' },
      errorMessage: 'Network timeout',
      errorStack: 'Error: Network timeout\n    at ...',
      attempts: 3,
    };

    const result = await repo.insert(input);

    expect(result).toEqual({ id: 'dlq-1' });
    expect(db.insert).toHaveBeenCalled();
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: 'spatula.crawl',
        jobId: 'bullmq-job-123',
        tenantId: 'tenant-1',
        spatulaJobId: 'job-1',
        payload: { taskId: 'task-1', url: 'https://example.com' },
        errorMessage: 'Network timeout',
        errorStack: expect.stringContaining('Network timeout'),
        attempts: 3,
      }),
    );
    expect(db.returning).toHaveBeenCalled();
  });

  it('insert wraps DB errors in StorageError', async () => {
    db.returning = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(
      repo.insert({ queueName: 'q', jobId: 'j', payload: {}, attempts: 1 }),
    ).rejects.toThrow('Failed to insert DLQ entry');
  });

  it('findUnresolved applies default limit=50, offset=0', async () => {
    await repo.findUnresolved();

    expect(db.select).toHaveBeenCalled();
    expect(db.where).toHaveBeenCalled();
    expect(db.orderBy).toHaveBeenCalled();
    expect(db.limit).toHaveBeenCalledWith(50);
    expect(db.offset).toHaveBeenCalledWith(0);
  });

  it('findUnresolved passes queue filter and pagination', async () => {
    await repo.findUnresolved({ queueName: 'spatula.crawl', limit: 10, offset: 20 });

    expect(db.limit).toHaveBeenCalledWith(10);
    expect(db.offset).toHaveBeenCalledWith(20);
    // where() is called with combined conditions (isNull + eq)
    expect(db.where).toHaveBeenCalled();
  });

  it('findById returns null when no row found', async () => {
    db.limit = vi.fn().mockResolvedValue([]);

    const result = await repo.findById('nonexistent');

    expect(result).toBeNull();
  });

  it('findById returns entry when found', async () => {
    const entry = { id: 'dlq-1', queueName: 'spatula.crawl' };
    db.limit = vi.fn().mockResolvedValue([entry]);

    const result = await repo.findById('dlq-1');

    expect(result).toEqual(entry);
  });

  it('resolve calls update with resolution and resolvedAt', async () => {
    const resolved = { id: 'dlq-1', resolvedAt: new Date(), resolution: 'retried' };
    db.returning = vi.fn().mockResolvedValue([resolved]);

    const result = await repo.resolve('dlq-1', 'retried');

    expect(result).toEqual(resolved);
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: 'retried',
        resolvedAt: expect.any(Date),
      }),
    );
    expect(db.where).toHaveBeenCalled();
  });

  it('resolve throws StorageError when entry not found', async () => {
    db.returning = vi.fn().mockResolvedValue([]);

    await expect(repo.resolve('nonexistent', 'discarded')).rejects.toThrow('DLQ entry not found');
  });

  it('countUnresolved returns numeric count', async () => {
    // countUnresolved uses select({ value: sql`count(*)` }) which returns [{ value }]
    db.where = vi.fn().mockResolvedValue([{ value: 42 }]);

    const count = await repo.countUnresolved();

    expect(count).toBe(42);
    expect(db.select).toHaveBeenCalled();
  });

  it('countUnresolved filters by queueName when provided', async () => {
    db.where = vi.fn().mockResolvedValue([{ value: 5 }]);

    const count = await repo.countUnresolved('spatula.export');

    expect(count).toBe(5);
    expect(db.where).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement DLQ repository**

```typescript
// packages/db/src/repositories/dlq-repository.ts
import { eq, isNull, desc, and, sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import { StorageError } from '@spatula/shared';
import { deadLetterQueue } from '../schema/dead-letter-queue.js';
import type { Database } from '../connection.js';

const logger = createLogger('dlq-repository');

export interface DlqInsertInput {
  queueName: string;
  jobId: string;
  tenantId?: string;
  spatulaJobId?: string;
  payload: unknown;
  errorMessage?: string;
  errorStack?: string;
  attempts: number;
}

export class DlqRepository {
  constructor(private readonly db: Database) {}

  async insert(input: DlqInsertInput): Promise<{ id: string }> {
    try {
      const [row] = await this.db
        .insert(deadLetterQueue)
        .values({
          queueName: input.queueName,
          jobId: input.jobId,
          tenantId: input.tenantId,
          spatulaJobId: input.spatulaJobId,
          payload: input.payload, // JSONB — Drizzle handles serialization
          errorMessage: input.errorMessage,
          errorStack: input.errorStack,
          attempts: input.attempts,
        })
        .returning();
      logger.info(
        { dlqId: row.id, queueName: input.queueName, jobId: input.jobId },
        'Job moved to DLQ',
      );
      return { id: row.id };
    } catch (error) {
      throw new StorageError('Failed to insert DLQ entry', {
        cause: error as Error,
        context: { queueName: input.queueName, jobId: input.jobId },
      });
    }
  }

  async findUnresolved(options?: {
    queueName?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<typeof deadLetterQueue.$inferSelect>> {
    // Build conditions array to avoid double .where() (which overwrites)
    const conditions = [isNull(deadLetterQueue.resolvedAt)];
    if (options?.queueName) {
      conditions.push(eq(deadLetterQueue.queueName, options.queueName));
    }

    return this.db
      .select()
      .from(deadLetterQueue)
      .where(and(...conditions))
      .orderBy(desc(deadLetterQueue.failedAt))
      .limit(options?.limit ?? 50)
      .offset(options?.offset ?? 0);
  }

  async findById(id: string): Promise<typeof deadLetterQueue.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async resolve(
    id: string,
    resolution: 'retried' | 'discarded' | 'fixed',
  ): Promise<typeof deadLetterQueue.$inferSelect> {
    const [row] = await this.db
      .update(deadLetterQueue)
      .set({
        resolvedAt: new Date(),
        resolution,
      })
      .where(eq(deadLetterQueue.id, id))
      .returning();

    if (!row) throw new StorageError('DLQ entry not found', { context: { id } });
    logger.info({ dlqId: id, resolution }, 'DLQ entry resolved');
    return row;
  }

  async countUnresolved(queueName?: string): Promise<number> {
    const conditions = queueName
      ? and(isNull(deadLetterQueue.resolvedAt), eq(deadLetterQueue.queueName, queueName))
      : isNull(deadLetterQueue.resolvedAt);

    const [{ value }] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(deadLetterQueue)
      .where(conditions);
    return Number(value);
  }
}
```

- [ ] **Step 3: Export from repo barrel**

Add to `packages/db/src/repositories/index.ts`:

```typescript
export { DlqRepository } from './dlq-repository.js';
export type { DlqInsertInput } from './dlq-repository.js';
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run dlq`

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/dlq-repository.ts packages/db/tests/unit/repositories/dlq-repository.test.ts packages/db/src/repositories/index.ts
git commit -m "feat(db): add DLQ repository for dead letter queue operations"
```

---

## Task 3: Failed Job Handler

**Files:**

- Create: `packages/queue/src/dlq-handler.ts`
- Create: `packages/queue/tests/unit/dlq-handler.test.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/queue/tests/unit/dlq-handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDlqHandler } from '../../src/dlq-handler.js';

describe('createDlqHandler', () => {
  it('inserts into DLQ when job has exhausted all attempts', async () => {
    const dlqRepo = { insert: vi.fn().mockResolvedValue({ id: 'dlq-1' }) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-123',
      name: 'crawl:https://example.com',
      data: {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com',
        depth: 0,
      },
      attemptsMade: 3,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };
    const error = new Error('Network timeout after 3 retries');

    await handler(mockJob as any, error);

    expect(dlqRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: 'spatula.crawl',
        jobId: 'bullmq-123',
        tenantId: 'tenant-1',
        spatulaJobId: 'job-1',
        errorMessage: 'Network timeout after 3 retries',
        attempts: 3,
      }),
    );
  });

  it('does NOT insert when job has remaining attempts', async () => {
    const dlqRepo = { insert: vi.fn() };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-123',
      data: { taskId: 'task-1', jobId: 'job-1', tenantId: 'tenant-1' },
      attemptsMade: 1,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };

    await handler(mockJob as any, new Error('transient'));

    expect(dlqRepo.insert).not.toHaveBeenCalled();
  });

  it('handles missing tenantId/jobId gracefully', async () => {
    const dlqRepo = { insert: vi.fn().mockResolvedValue({ id: 'dlq-1' }) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-456',
      data: { someField: 'value' }, // no tenantId or jobId
      attemptsMade: 2,
      opts: { attempts: 2 },
      queueName: 'spatula.export',
    };

    await handler(mockJob as any, new Error('failed'));

    expect(dlqRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: undefined,
        spatulaJobId: undefined,
      }),
    );
  });

  it('does not throw if DLQ insert fails', async () => {
    const dlqRepo = { insert: vi.fn().mockRejectedValue(new Error('DB down')) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-789',
      data: {},
      attemptsMade: 3,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };

    // Should not throw — DLQ insertion failure should be logged, not propagated
    await expect(handler(mockJob as any, new Error('original'))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement DLQ handler**

```typescript
// packages/queue/src/dlq-handler.ts
import { createLogger } from '@spatula/shared';
import type { Job } from 'bullmq';
import type { DlqRepository } from '@spatula/db';

const logger = createLogger('dlq-handler');

/**
 * Creates a BullMQ `failed` event handler that moves permanently failed
 * jobs to the dead letter queue table.
 *
 * Only inserts when the job has exhausted all retry attempts
 * (attemptsMade >= opts.attempts). Transient failures that will be
 * retried are ignored.
 *
 * The handler never throws — DLQ insertion failures are logged but
 * do not affect the worker's operation.
 */
export function createDlqHandler(dlqRepo: DlqRepository) {
  return async (job: Job | undefined, err: Error): Promise<void> => {
    if (!job) {
      logger.warn({ error: err.message }, 'DLQ handler called without job reference');
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Job will be retried — don't move to DLQ yet
      return;
    }

    try {
      await dlqRepo.insert({
        queueName: job.queueName,
        jobId: job.id ?? 'unknown',
        tenantId: (job.data as any)?.tenantId,
        spatulaJobId: (job.data as any)?.jobId,
        payload: job.data,
        errorMessage: err.message,
        errorStack: err.stack,
        attempts: job.attemptsMade,
      });
    } catch (dlqError) {
      // Never throw from the DLQ handler — log and continue
      logger.error(
        { jobId: job.id, queueName: job.queueName, error: (dlqError as Error).message },
        'Failed to insert into DLQ — original error will be lost',
      );
    }
  };
}
```

- [ ] **Step 3: Export from queue barrel**

Add to `packages/queue/src/index.ts`:

```typescript
export { createDlqHandler } from './dlq-handler.js';
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run dlq-handler`

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/dlq-handler.ts packages/queue/tests/unit/dlq-handler.test.ts packages/queue/src/index.ts
git commit -m "feat(queue): add DLQ handler for permanently failed BullMQ jobs"
```

---

## Task 4: Wire DLQ Handler into Worker Entrypoint

**Files:**

- Modify: `packages/queue/src/worker-entrypoint.ts`

- [ ] **Step 1: Attach failed handlers to all workers**

Read the current `packages/queue/src/worker-entrypoint.ts`. After each `new Worker(...)` instantiation, attach the DLQ handler to the worker's `failed` event.

The handler needs a `DlqRepository` instance. Since the worker entrypoint creates the DB connection, it can create the repo:

```typescript
import { createDlqHandler } from './dlq-handler.js';
import { DlqRepository } from '@spatula/db';

// After createDatabasePool():
const { db, pool } = createDatabasePool();
const dlqRepo = new DlqRepository(db);
const dlqHandler = createDlqHandler(dlqRepo);

// After each worker creation:
worker.on('failed', (job, err) => void dlqHandler(job, err));
```

Apply to all 4 workers (crawl, schema-evolution, reconciliation, export).

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @spatula/queue build`

- [ ] **Step 3: Commit**

```bash
git add packages/queue/src/worker-entrypoint.ts
git commit -m "feat(queue): wire DLQ handler into all worker instances"
```

---

## Task 5: Admin DLQ API Routes

**Files:**

- Create: `apps/api/src/routes/admin-dlq.ts`
- Create: `apps/api/tests/unit/routes/admin-dlq.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Add dlqRepo to AppDeps**

In `apps/api/src/types.ts`, add:

```typescript
import type { DlqRepository } from '@spatula/db';

// Add to AppDeps interface:
dlqRepo?: DlqRepository;
queues?: SpatulaQueues;  // For DLQ retry re-enqueue
```

Optional so existing code doesn't break.

- [ ] **Step 2: Create admin DLQ routes**

```typescript
// apps/api/src/routes/admin-dlq.ts
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminDlqRoutes() {
  const app = new Hono<AppEnv>();

  // List unresolved DLQ entries
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const queueName = c.req.query('queue');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const entries = await deps.dlqRepo.findUnresolved({ queueName, limit, offset });
    const total = await deps.dlqRepo.countUnresolved(queueName);

    return c.json({ data: entries, pagination: { total, limit, offset } });
  });

  // Get single DLQ entry
  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const entry = await deps.dlqRepo.findById(c.req.param('id'));
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);

    return c.json({ data: entry });
  });

  // Retry a DLQ entry (re-enqueue to original queue + mark resolved)
  app.post('/:id/retry', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const entry = await deps.dlqRepo.findById(c.req.param('id'));
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt)
      return c.json(
        { error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } },
        409,
      );

    // Re-enqueue the original job data to the original queue
    // Note: Full re-enqueue requires SpatulaQueues in AppDeps.
    // If queues are not available, mark as retried without re-enqueue.
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

    const entry = await deps.dlqRepo.findById(c.req.param('id'));
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

**Note on retry re-enqueue:** The retry endpoint re-enqueues the original payload to the target BullMQ queue via `deps.queues` and marks the DLQ entry as resolved. `SpatulaQueues` is added as an optional field on `AppDeps` to avoid breaking existing tests. If `deps.queues` is not available (e.g., in test environments without queue infrastructure), the entry is still marked as retried in the DB but no actual re-enqueue occurs.

- [ ] **Step 3: Mount admin routes in app.ts**

Add to `apps/api/src/app.ts` after the existing routes:

```typescript
import { adminDlqRoutes } from './routes/admin-dlq.js';

// Admin routes (after existing API routes)
app.route('/api/v1/admin/dlq', adminDlqRoutes());
```

**Security note:** Admin routes currently use the same tenant middleware as regular API routes but the DLQ queries have NO tenant scoping — any tenant can see all tenants' failed jobs. This is a known gap: Phase 12 Workstream B (auth) will add `requireScope('admin')` middleware for admin routes. Until then, this endpoint exposes cross-tenant data. For production, either (a) add a tenant filter to `findUnresolved`/`findById` queries, or (b) restrict these routes to admin-only auth before deploying.

- [ ] **Step 4: Write route tests**

```typescript
// apps/api/tests/unit/routes/admin-dlq.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const SAMPLE_DLQ_ENTRY = {
  id: 'dlq-1',
  queueName: 'spatula.crawl',
  jobId: 'bullmq-123',
  tenantId: TENANT_ID,
  spatulaJobId: 'job-1',
  payload: { taskId: 'task-1', url: 'https://example.com' },
  errorMessage: 'Network timeout',
  errorStack: 'Error: Network timeout\n    at ...',
  attempts: 3,
  failedAt: new Date('2026-03-25T10:00:00Z'),
  resolvedAt: null,
  resolution: null,
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn(),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
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
    dlqRepo: {
      findUnresolved: vi.fn().mockResolvedValue([SAMPLE_DLQ_ENTRY]),
      countUnresolved: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue(SAMPLE_DLQ_ENTRY),
      resolve: vi
        .fn()
        .mockResolvedValue({ ...SAMPLE_DLQ_ENTRY, resolvedAt: new Date(), resolution: 'retried' }),
      insert: vi.fn(),
    } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/dlq', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns unresolved entries with pagination', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].queueName).toBe('spatula.crawl');
    expect(body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it('passes queue filter and pagination params to repo', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/dlq?queue=spatula.export&limit=10&offset=5', {
      headers: tenantHeader,
    });

    expect((deps as any).dlqRepo.findUnresolved).toHaveBeenCalledWith({
      queueName: 'spatula.export',
      limit: 10,
      offset: 5,
    });
    expect((deps as any).dlqRepo.countUnresolved).toHaveBeenCalledWith('spatula.export');
  });

  it('clamps limit to max 100', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/dlq?limit=500', { headers: tenantHeader });

    expect((deps as any).dlqRepo.findUnresolved).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('returns 503 when dlqRepo is not configured', async () => {
    deps = createMockDeps({ dlqRepo: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });
});

describe('GET /api/v1/admin/dlq/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns single DLQ entry', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('dlq-1');
    expect(body.data.queueName).toBe('spatula.crawl');
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/nonexistent', { headers: tenantHeader });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/admin/dlq/:id/retry', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolves entry as retried', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution).toBe('retried');
    expect((deps as any).dlqRepo.resolve).toHaveBeenCalledWith('dlq-1', 'retried');
  });

  it('re-enqueues job to original queue when queues are available', async () => {
    const mockCrawlQueue = { add: vi.fn().mockResolvedValue({}) };
    deps = createMockDeps({
      queues: {
        crawl: mockCrawlQueue,
        schemaEvolution: { add: vi.fn() },
        reconciliation: { add: vi.fn() },
        export: { add: vi.fn() },
      } as any,
    });

    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(mockCrawlQueue.add).toHaveBeenCalledWith(
      expect.stringContaining('dlq-retry:'),
      SAMPLE_DLQ_ENTRY.payload,
    );
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 for already-resolved entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'discarded',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_RESOLVED');
  });
});

describe('POST /api/v1/admin/dlq/:id/discard', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolves entry as discarded', async () => {
    (deps as any).dlqRepo.resolve = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'discarded',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution).toBe('discarded');
    expect((deps as any).dlqRepo.resolve).toHaveBeenCalledWith('dlq-1', 'discarded');
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 for already-resolved entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'retried',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 5: Update mock deps in existing tests**

Add `dlqRepo: undefined` to any test file that constructs `AppDeps` mocks (if TypeScript errors — since it's optional, most won't need changes).

- [ ] **Step 6: Run tests**

Run:

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run admin-dlq
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin-dlq.ts apps/api/tests/unit/routes/admin-dlq.test.ts apps/api/src/app.ts apps/api/src/types.ts
git commit -m "feat(api): add admin DLQ routes for listing, retrying, and discarding failed jobs"
```

---

## Task 6: Integration Verification

- [ ] **Step 1: Run full db test suite**

Run: `pnpm --filter @spatula/db test -- --run`

- [ ] **Step 2: Run full queue test suite**

Run: `pnpm --filter @spatula/queue test -- --run`

- [ ] **Step 3: Run full API test suite**

Run: `pnpm --filter @spatula/api test -- --run`

- [ ] **Step 4: Run builds**

Run: `pnpm --filter @spatula/db build && pnpm --filter @spatula/queue build`

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.2c — dead letter queue complete"
```
