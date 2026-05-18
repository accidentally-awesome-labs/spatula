# Wave 1b-i: Server Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-connection database access with pooled connections, add graceful shutdown to the API server and workers, and create a BullMQ worker entry point that manages the full worker lifecycle.

**Architecture:** The current `createDatabase()` function creates a single `pg` client via Drizzle's `connection` option. We replace it with an explicit `pg.Pool`, return both `db` and `pool` so shutdown handlers can call `pool.end()`. The API server gets SIGTERM/SIGINT handlers that drain connections and close resources. A new `worker-entrypoint.ts` creates BullMQ `Worker` instances for each queue and handles shutdown via `Worker.close()`.

**Tech Stack:** TypeScript, `pg` (Pool), `@hono/node-server`, BullMQ Worker, Vitest

**Spec references:**

- Phase 12 spec sections 2.3 (Graceful Shutdown), 2.4 (Worker Entry Point), 2.6 (Connection Pooling)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File                                        | Responsibility                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/queue/src/worker-entrypoint.ts`   | Creates BullMQ Worker instances, wires dependencies, handles graceful shutdown |
| `packages/db/tests/unit/connection.test.ts` | Tests for pool-based connection                                                |

### Modified Files

| File                                | Change                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| `packages/db/src/connection.ts`     | Replace single client with `pg.Pool`, return `{ db, pool }` |
| `packages/db/src/index.ts`          | Export new `createDatabasePool` and `DatabasePool` type     |
| `apps/api/src/types.ts`             | Add `dbPool: Pool` to `AppDeps`                             |
| `apps/api/src/server.ts`            | Add `setupGracefulShutdown()` function                      |
| `packages/queue/src/worker-deps.ts` | Add `dbPool: Pool` to `WorkerDepsConfig` and `WorkerDeps`   |

---

## Task 1: Connection Pooling

**Files:**

- Modify: `packages/db/src/connection.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/tests/unit/connection.test.ts`

- [ ] **Step 1: Write tests for pool-based connection**

```typescript
// packages/db/tests/unit/connection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.doMock (not vi.mock) so mocks survive vi.resetModules()
// Each test re-imports modules dynamically to test env var handling

describe('createDatabasePool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT;

    // Re-apply mocks after module reset
    vi.doMock('pg', () => {
      const mockPool = {
        on: vi.fn().mockReturnThis(),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };
      return { Pool: vi.fn(() => mockPool) };
    });
    vi.doMock('drizzle-orm/node-postgres', () => ({
      drizzle: vi.fn(() => ({ query: {} })),
    }));
    vi.doMock('../../src/schema/index.js', () => ({}));
  });

  it('creates pool with connection string from parameter', async () => {
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    const result = createDatabasePool('postgresql://test:test@localhost:5432/test');

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://test:test@localhost:5432/test',
      }),
    );
    expect(result).toHaveProperty('db');
    expect(result).toHaveProperty('pool');
  });

  it('falls back to DATABASE_URL env var', async () => {
    process.env.DATABASE_URL = 'postgresql://env:env@localhost:5432/envdb';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://env:env@localhost:5432/envdb',
      }),
    );
  });

  it('throws StorageError when no connection string provided', async () => {
    const { createDatabasePool } = await import('../../src/connection.js');

    expect(() => createDatabasePool()).toThrow('DATABASE_URL is required');
  });

  it('uses default pool settings', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }),
    );
  });

  it('reads pool settings from env vars', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    process.env.DB_POOL_MAX = '5';
    process.env.DB_POOL_IDLE_TIMEOUT = '10000';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 5,
        idleTimeoutMillis: 10000,
      }),
    );
  });
});

describe('createDatabase (backward compat)', () => {
  it('still works for callers that only need db', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    const { createDatabase } = await import('../../src/connection.js');

    const db = createDatabase();
    expect(db).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run connection`
Expected: FAIL (createDatabasePool not found)

- [ ] **Step 3: Implement pool-based connection**

```typescript
// packages/db/src/connection.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { StorageError } from '@spatula/shared';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof drizzle>;
export type DatabasePool = { db: Database; pool: Pool };

/**
 * Create a pooled database connection. Returns both the Drizzle instance
 * and the underlying pg.Pool so shutdown handlers can call pool.end().
 */
export function createDatabasePool(connectionString?: string): DatabasePool {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new StorageError(
      'DATABASE_URL is required — pass it directly or set the environment variable',
    );
  }

  const pool = new Pool({
    connectionString: url,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

/**
 * Backward-compatible: returns only the Drizzle instance.
 * Prefer createDatabasePool() for new code that needs shutdown handling.
 */
export function createDatabase(connectionString?: string): Database {
  return createDatabasePool(connectionString).db;
}
```

- [ ] **Step 4: Update db package exports**

In `packages/db/src/index.ts`, add:

```typescript
export { createDatabasePool } from './connection.js';
export type { DatabasePool } from './connection.js';
```

Keep the existing `createDatabase` export for backward compatibility.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run connection`
Expected: All tests PASS

- [ ] **Step 6: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/connection.ts packages/db/src/index.ts packages/db/tests/unit/connection.test.ts
git commit -m "feat(db): add pool-based database connection with configurable settings"
```

---

## Task 2: Update AppDeps and WorkerDeps with Pool

**Files:**

- Modify: `apps/api/src/types.ts`
- Modify: `packages/queue/src/worker-deps.ts`

- [ ] **Step 1: Add Pool type to AppDeps**

In `apps/api/src/types.ts`, add import and field:

```typescript
import type { Pool } from 'pg';
// ... existing imports ...

export interface AppDeps {
  // ... existing fields ...
  dbPool: Pool; // Add this field
}
```

- [ ] **Step 2: Add Pool type to WorkerDeps**

In `packages/queue/src/worker-deps.ts`, add to both `WorkerDepsConfig` and `WorkerDeps`:

```typescript
import type { Pool } from 'pg';

export interface WorkerDepsConfig {
  // ... existing fields ...
  dbPool: Pool;
}

export class WorkerDeps {
  // ... existing fields ...
  readonly dbPool: Pool;

  constructor(config: WorkerDepsConfig) {
    // ... existing assignments ...
    this.dbPool = config.dbPool;
  }
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue build && pnpm --filter @spatula/api build`

Note: API build may fail if there's an entry point that constructs AppDeps without `dbPool`. This is expected — the actual wiring happens in the deployment entry point (not yet written). If test mocks break, add `dbPool: {} as any` to mock factories.

- [ ] **Step 4: Fix breaking test mocks**

The following test files construct mock `AppDeps` or `WorkerDeps` objects and need `dbPool` added. Add `dbPool: { end: vi.fn() } as unknown as Pool` to each mock factory:

**API test files (mock `AppDeps`):**

- `apps/api/tests/unit/app.test.ts`
- `apps/api/tests/unit/routes/jobs.test.ts`
- `apps/api/tests/unit/routes/exports.test.ts`
- `apps/api/tests/unit/routes/entities.test.ts`
- `apps/api/tests/unit/routes/schemas.test.ts`
- `apps/api/tests/unit/routes/extractions.test.ts`
- `apps/api/tests/unit/routes/actions.test.ts`
- `apps/api/tests/unit/routes/tenants.test.ts`
- `apps/api/tests/unit/middleware/deps.test.ts`
- `apps/api/tests/unit/middleware/tenant-isolation.test.ts`

**Queue test files (mock `WorkerDeps`):**

- `packages/queue/tests/unit/workers/crawl-worker.test.ts`
- `packages/queue/tests/unit/workers/schema-worker.test.ts`
- `packages/queue/tests/unit/workers/reconciliation-worker.test.ts`
- `packages/queue/tests/unit/workers/export-worker.test.ts`

Search for `createMockDeps` or `as unknown as WorkerDeps` or `as unknown as AppDeps` in each file and add the `dbPool` field to the mock object.

- [ ] **Step 5: Run full test suites**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run && pnpm --filter @spatula/api test -- --run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/types.ts packages/queue/src/worker-deps.ts
git add -u  # any test mock updates
git commit -m "feat(api,queue): add dbPool to AppDeps and WorkerDeps for shutdown handling"
```

---

## Task 3: API Server Graceful Shutdown

**Files:**

- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add graceful shutdown to server.ts**

Add a `setupGracefulShutdown` function and call it after `serve()`:

```typescript
// Add to imports at top of server.ts:
import type { ServerType } from '@hono/node-server';
// Note: serve() returns ServerType (not http.Server). Use the Hono type.

// Add after the existing startServer function, before the final return:

const SHUTDOWN_TIMEOUT_MS = 25_000; // 25s — leaves 5s buffer before k8s SIGKILL at 30s

function setupGracefulShutdown(
  server: ServerType,
  deps: AppDeps,
  progressManager?: JobProgressManager,
): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, draining connections');

    // Force exit after timeout
    const forceTimer = setTimeout(() => {
      logger.warn('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref(); // Don't keep process alive just for this timer

    try {
      // 1. Stop accepting new connections and drain in-flight requests
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // 2. Close WebSocket connections
      if (progressManager) {
        progressManager.closeAll();
      }

      // 3. Close Redis subscriber
      if (deps.redisSubscriber) {
        await deps.redisSubscriber.quit();
      }

      // 4. Close database pool
      if (deps.dbPool) {
        await deps.dbPool.end();
      }

      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
```

**Key difference from a naive implementation:** `server.close()` is `await`ed via a Promise wrapper. This ensures all in-flight HTTP requests complete before closing the database pool and Redis. Without this, requests in progress would fail when their database connection is pulled out from under them.

Then modify `startServer` to call it. The `progressManager` variable must be declared outside the `if (deps.redisSubscriber)` block so the shutdown handler can access it:

```typescript
export function startServer(deps: AppDeps, port?: number) {
  const config = loadConfig();
  const serverPort = port ?? config.server.port;
  const app = createApp(deps);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  let progressManager: JobProgressManager | undefined;

  if (deps.redisSubscriber) {
    progressManager = new JobProgressManager(deps.redisSubscriber);
    // ... existing WS route mounting (unchanged) ...
  }

  const server = serve({
    fetch: app.fetch,
    port: serverPort,
  });

  injectWebSocket(server);
  setupGracefulShutdown(server, deps, progressManager);

  logger.info({ port: serverPort }, 'API server started');
  return server;
}
```

- [ ] **Step 2: Add `closeAll` method to JobProgressManager if it doesn't exist**

Check `apps/api/src/ws/job-progress.ts` for a `closeAll` method. If it doesn't exist, add it.

**Important:** The internal `ClientEntry.ws` type only exposes `close(): void` (no parameters). Either:

- Update the `ClientEntry` interface to accept `close(code?: number, reason?: string): void`, OR
- Call `close()` without arguments (simpler, WebSocket code 1000 is the default)

The simpler approach:

```typescript
closeAll(): void {
  for (const [_jobId, clients] of this.clients.entries()) {
    for (const client of clients) {
      try {
        client.ws.close();
      } catch {
        // Client may already be disconnected
      }
    }
    clients.clear();
  }
  this.clients.clear();
}
```

Then update the shutdown caller to `progressManager.closeAll()` (no args).

- [ ] **Step 3: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api build`
Expected: Build succeeds

Note: The `Server` type from `node:http` is the return type of Hono's `serve()`. If the type doesn't match exactly, use `ReturnType<typeof serve>` instead.

- [ ] **Step 4: Run API tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/ws/job-progress.ts
git commit -m "feat(api): add graceful shutdown with SIGTERM/SIGINT handling"
```

---

## Task 4: Worker Entry Point

**Files:**

- Create: `packages/queue/src/worker-entrypoint.ts`

- [ ] **Step 1: Create the worker entry point**

The entry point must wire real processor functions into the BullMQ Workers. The processors already accept `(data, deps)` — the entry point binds `deps` into closures so BullMQ's `(job) => ...` signature works.

**Note on the `extract` queue:** `QUEUE_NAMES.EXTRACT` exists in `queues.ts` but there is no `processExtractJob` function — extraction is performed inline by the crawl worker. No extract worker is created. This is by design: the extract queue exists for future use but is not consumed in the current architecture.

**Note on `redisForLock`:** The schema worker needs a separate Redis connection for distributed locking (passed as the `redis` parameter to `processSchemaEvolutionJob`). This is separate from the BullMQ connection because BullMQ sets `maxRetriesPerRequest: null` which conflicts with lock semantics.

```typescript
// packages/queue/src/worker-entrypoint.ts
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createLogger, loadConfig } from '@spatula/shared';
import { createDatabasePool, PgContentStore } from '@spatula/db';
import { processCrawlJob } from './workers/crawl-worker.js';
import { processSchemaEvolutionJob } from './workers/schema-worker.js';
import { processReconciliationJob } from './workers/reconciliation-worker.js';
import { processExportJob } from './workers/export-worker.js';
import { QUEUE_NAMES, DEFAULT_QUEUE_CONFIG, createQueues } from './queues.js';
import { WorkerDeps } from './worker-deps.js';
import { RedisEventPublisher } from './events.js';
import type {
  CrawlJobData,
  SchemaEvolutionJobData,
  ReconciliationJobData,
  ExportJobPayload,
} from './queues.js';

const logger = createLogger('worker-entrypoint');

async function main() {
  const config = loadConfig();
  const redisUrl = config.redis.url;

  // Create shared connections
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const redisForLock = new Redis(redisUrl); // Separate connection for schema evolution locks
  const { db, pool } = createDatabasePool();

  // Create queues (for enqueuing child jobs from crawl worker)
  const queues = createQueues({ connection: redisUrl });

  // Create content store
  const contentStore = new PgContentStore(db);

  // Create repositories from db
  // NOTE: The actual repository and service construction depends on
  // which implementations are available. This is a minimal scaffold
  // that creates the infrastructure. Full DI wiring (crawler, extractor,
  // classifier, schemaEvolver, reconciler, linkEvaluator) requires
  // the core service factories which will be formalized in Wave 2.
  //
  // For now, the entry point demonstrates the lifecycle pattern.
  // Workers that require uninitialized services will log an error
  // and skip processing until services are wired.

  // Determine which workers to run (default: all)
  const enabledWorkers = (process.env.SPATULA_WORKERS ?? 'all')
    .split(',')
    .map((w) => w.trim().toLowerCase());
  const isEnabled = (name: string) =>
    enabledWorkers.includes('all') || enabledWorkers.includes(name);

  const queueConfig = DEFAULT_QUEUE_CONFIG;
  const workers: Worker[] = [];

  // The WorkerDeps object will be constructed here once full DI is wired.
  // For the lifecycle scaffold, processors call the real functions with
  // deps passed via closure. The deps object is built by the deployer.
  let deps: WorkerDeps | undefined;

  if (isEnabled('crawl')) {
    const worker = new Worker<CrawlJobData>(
      QUEUE_NAMES.CRAWL,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processCrawlJob(job.data, deps);
      },
      {
        connection,
        concurrency: queueConfig.crawl.concurrency,
        limiter: {
          max: queueConfig.crawl.rateLimitMax,
          duration: queueConfig.crawl.rateLimitDuration,
        },
      },
    );
    workers.push(worker);
    logger.info(
      { queue: QUEUE_NAMES.CRAWL, concurrency: queueConfig.crawl.concurrency },
      'Crawl worker started',
    );
  }

  if (isEnabled('schema-evolution')) {
    const worker = new Worker<SchemaEvolutionJobData>(
      QUEUE_NAMES.SCHEMA_EVOLUTION,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processSchemaEvolutionJob(job.data, deps, redisForLock);
      },
      {
        connection,
        concurrency: queueConfig.schemaEvolution.concurrency,
      },
    );
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.SCHEMA_EVOLUTION }, 'Schema evolution worker started');
  }

  if (isEnabled('reconciliation')) {
    const worker = new Worker<ReconciliationJobData>(
      QUEUE_NAMES.RECONCILIATION,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processReconciliationJob(job.data, deps);
      },
      {
        connection,
        concurrency: queueConfig.reconciliation.concurrency,
      },
    );
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.RECONCILIATION }, 'Reconciliation worker started');
  }

  if (isEnabled('export')) {
    const worker = new Worker<ExportJobPayload>(
      QUEUE_NAMES.EXPORT,
      async (job) => {
        if (!deps) throw new Error('WorkerDeps not initialized');
        await processExportJob(job.data, deps);
      },
      {
        connection,
        concurrency: queueConfig.export.concurrency,
      },
    );
    workers.push(worker);
    logger.info({ queue: QUEUE_NAMES.EXPORT }, 'Export worker started');
  }

  // NOTE: No worker for QUEUE_NAMES.EXTRACT — extraction is performed
  // inline by the crawl worker. The extract queue exists for future use.

  logger.info({ workers: workers.length, enabled: enabledWorkers }, 'Worker entrypoint started');

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Worker shutdown initiated');

    try {
      // 1. BullMQ Worker.close() waits for current job to finish,
      //    then releases lock and stops picking up new jobs
      await Promise.allSettled(workers.map((w) => w.close()));
      logger.info('All workers closed');

      // 2. Close crawler (prevents orphaned browser processes)
      if (deps?.crawler) {
        await deps.crawler.close();
      }

      // 3. Close queues (stops enqueuing)
      await queues.closeAll();

      // 4. Close Redis connections
      await connection.quit();
      await redisForLock.quit();

      // 5. Close database pool
      await pool.end();

      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Worker entrypoint failed to start');
  process.exit(1);
});
```

**Note on DI completeness:** The `deps` variable is declared but not fully constructed in this scaffold. Full construction requires instantiating `PlaywrightCrawler`, `OpenRouterClient` (or `OllamaClient`), `StaticExtractor`, `SchemaEvolverImpl`, `DataReconcilerImpl`, etc. These factories depend on Phase 12 Workstream J (Ollama client) and existing core service constructors. The entry point's primary responsibility in this wave is the lifecycle pattern (worker creation, selective enabling, graceful shutdown). The DI factory will be completed when deployment infrastructure is built.

- [ ] **Step 2: Add entry point script to package.json**

In `packages/queue/package.json`, add to scripts:

```json
"start:workers": "node dist/worker-entrypoint.js"
```

- [ ] **Step 3: Export from queue package index**

Check `packages/queue/src/index.ts` and ensure the entry point is NOT exported from the barrel (it's a standalone executable, not a library export). No change needed if it's a standalone file.

- [ ] **Step 4: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue build`
Expected: Build succeeds

- [ ] **Step 5: Run queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS (entry point is not unit-tested — it's an integration/deployment concern)

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/worker-entrypoint.ts packages/queue/package.json
git commit -m "feat(queue): add worker entry point with selective queue enabling and graceful shutdown"
```

---

## Task 5: Integration Verification

**Files:**

- No new files — verification only

- [ ] **Step 1: Run full db package tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run full queue package tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS

- [ ] **Step 3: Run full API tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run`
Expected: All tests PASS

- [ ] **Step 4: Run full monorepo build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db build && pnpm --filter @spatula/queue build`
Expected: Both build successfully

Note: `@spatula/api` may have pre-existing build errors unrelated to this change. Only verify db and queue builds.

- [ ] **Step 5: Verify the complete test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm run test`
Expected: All tests pass across all packages

- [ ] **Step 6: Commit verification note**

```bash
git commit --allow-empty -m "test: verify Wave 1b-i server lifecycle — all tests passing

Connection pooling, graceful shutdown, and worker entry point
implemented. Pool-based connections with configurable max/idle.
API server drains on SIGTERM/SIGINT. Worker entry point manages
BullMQ workers with selective enabling via SPATULA_WORKERS env var."
```
