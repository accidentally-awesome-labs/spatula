# Tier 5A: Queue/Worker Integration Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build end-to-end tests for the async job processing pipeline — BullMQ workers processing crawl/extract/evolve/reconcile/export jobs, webhook delivery, DLQ, state machine enforcement, graceful shutdown, and worker heartbeat.

**Architecture:** Workers run in-process via `new Worker(queueName, processor, { connection })` using exported processor functions from `@spatula/queue`. Mock Ollama + fixture HTTP server from Tier 2 provide deterministic LLM responses and crawl targets. Real Postgres + Redis from Docker (Tier 4) store all state. A shared `startTestWorkers()` helper wires the full worker dep graph. Tests poll for job completion via `waitForJobStatus()`.

**Tech Stack:** TypeScript, Vitest, BullMQ, `@spatula/queue` (WorkerDeps, processor functions, JobManager), `@spatula/db` (Postgres repos), Docker (Postgres + Redis), Tier 2 mock Ollama + fixture server

**Spec:** `docs/superpowers/specs/2026-04-05-tier5-queue-worker-and-security-testing-design.md` (Section 2)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/cli/tests/e2e/tier5/tier5a/helpers.ts` | `startTestWorkers()`, `waitForJobStatus()`, `createTestJobManager()` |
| `apps/cli/tests/e2e/tier5/tier5a/job-lifecycle.test.ts` | Tests 1-5: job create/complete/entities/schema/pause-resume |
| `apps/cli/tests/e2e/tier5/tier5a/export-processing.test.ts` | Tests 6-8: export via worker |
| `apps/cli/tests/e2e/tier5/tier5a/webhook-delivery.test.ts` | Tests 9-11: webhook via queue |
| `apps/cli/tests/e2e/tier5/tier5a/dlq.test.ts` | Tests 12-14: dead letter queue |
| `apps/cli/tests/e2e/tier5/tier5a/state-machine.test.ts` | Tests 15-17: transitions, cancel, quota |
| `apps/cli/tests/e2e/tier5/tier5a/worker-lifecycle.test.ts` | Tests 18-22: shutdown, re-run, ws-token, heartbeat, audit |
| `apps/cli/tests/e2e/tier5/tier5a/migration.test.ts` | Test 23: migration preserves data |

### Modified files

| File | Change |
|------|--------|
| `apps/cli/package.json` | Add `@spatula/queue` devDependency; add `test:tier5a` script |
| `packages/queue/src/index.ts` | Export `createWebhookWorker` |
| `apps/cli/scripts/tier-registry.ts` | Add tier `5a` definition |

---

## Task 1: Dependencies + Exports

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `packages/queue/src/index.ts`
- Modify: `apps/cli/scripts/tier-registry.ts`

- [ ] **Step 1: Add @spatula/queue devDependency**

In `apps/cli/package.json`, add to `devDependencies`:
```json
"@spatula/queue": "workspace:*"
```

Run: `cd /Users/salar/Projects/spatula && pnpm install`

- [ ] **Step 2: Export createWebhookWorker from queue barrel**

In `packages/queue/src/index.ts`, add:
```typescript
export { createWebhookWorker } from './webhook-worker.js';
```

- [ ] **Step 3: Add tier 5a to registry**

In `apps/cli/scripts/tier-registry.ts`, add to the `TIERS` object:
```typescript
'5a': {
  name: 'Queue/Worker Integration',
  description: 'Tier 4 + BullMQ workers processing jobs end-to-end',
  extends: '4',
  services: ['ollama', 'docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/tier5a/'],
},
```

Add `test:tier5a` to `apps/cli/package.json` scripts:
```json
"test:tier5a": "tsx scripts/test-tiers.ts --tier=5a"
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/package.json packages/queue/src/index.ts apps/cli/scripts/tier-registry.ts pnpm-lock.yaml
git commit -m "feat: add @spatula/queue devDep, export createWebhookWorker, add tier 5a"
```

---

## Task 2: Tier 5A Test Helpers

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/helpers.ts`

- [ ] **Step 1: Create the helpers module**

This is the most complex helper — it wires the full worker dep graph. Read these files before implementing:
- `packages/queue/src/worker-deps.ts` — `WorkerDepsConfig` interface
- `packages/queue/src/queues.ts` — `createQueues`, `SpatulaQueues`
- `packages/queue/src/job-manager.ts` — `JobManager`, `JobManagerConfig`
- `packages/queue/src/dlq-handler.ts` — `createDlqHandler`
- `apps/cli/tests/e2e/tier2/helpers.ts` — Tier 2 helpers for reference
- `apps/cli/tests/e2e/tier2/fixture-server.ts` — fixture server
- `apps/cli/tests/e2e/tier2/mock-ollama.ts` — mock Ollama

The helper exports:

**`startTestWorkers(opts)`:**
```typescript
export interface TestWorkerHarness {
  workers: Worker[];
  workerDeps: WorkerDeps;
  queues: SpatulaQueues;
  jobManager: JobManager;
  fixtureServer: FixtureServer;
  mockOllama: MockOllamaServer;
  webhookReceiver: WebhookReceiver;
  app: HonoApp; // API app for route testing
  tenantId: string;
  pool: Pool;
  db: Database;
  closeAll(): Promise<void>;
}

export async function startTestWorkers(opts: {
  databaseUrl: string;
  redisUrl: string;
}): Promise<TestWorkerHarness | null>
```

Implementation:
1. Return null if `databaseUrl` not set
2. Start fixture server (from `../../tier2/fixture-server.js`)
3. Start mock Ollama (from `../../tier2/mock-ollama.js`)
4. Create Postgres pool via `createDatabasePool(databaseUrl)` from `@spatula/db`
5. Create all repository instances from the db
6. Create Redis connection: `{ host: 'localhost', port: 6380, db: 1, maxRetriesPerRequest: null }`
7. Create `SpatulaQueues` via `createQueues(redisConnection)`
8. Create DLQ handler via `createDlqHandler(dlqRepo)`
9. Build LLM components from mock Ollama (PageClassifier, StaticExtractor, SchemaEvolverImpl, DataReconcilerImpl, LLMLinkEvaluator) — same wiring as Tier 2 helpers
10. Create Playwright crawler (skip tests if not available)
11. Create `LocalContentStore` pointed at a temp dir
12. Create `WorkerDeps` with all of the above
13. Create 5 BullMQ Workers:
    - Crawl: `new Worker(QUEUE_NAMES.CRAWL, async (job) => processCrawlJob(job.data, workerDeps), { connection: redisConnection, concurrency: 1 })`
    - Schema evolution: `new Worker(QUEUE_NAMES.SCHEMA_EVOLUTION, async (job) => processSchemaEvolutionJob(job.data, workerDeps), { connection: redisConnection, concurrency: 1 })`
    - Reconciliation: `new Worker(QUEUE_NAMES.RECONCILIATION, async (job) => processReconciliationJob(job.data, workerDeps), { connection: redisConnection, concurrency: 1 })`
    - Export: `new Worker(QUEUE_NAMES.EXPORT, async (job) => processExportJob(job.data, workerDeps), { connection: redisConnection, concurrency: 1 })`
    - Webhook: `new Worker(QUEUE_NAMES.WEBHOOK, async (job) => { const sender = new WebhookSender(); await sender.send(job.data.url, job.data.event, job.data.secret); }, { connection: redisConnection, concurrency: 1 })`
14. Attach DLQ handler to each worker: `worker.on('failed', dlqHandler)`
15. Create `JobManager({ jobRepo, taskRepo, schemaRepo, queues, tenantRepo })`
16. Create webhook receiver
17. Create API app via `createTestApp()` from Tier 4 helpers (with real jobManager, not stubbed)
18. Create a test tenant
19. Return harness with `closeAll()` that: closes workers → closes queues → closes crawler → closes Redis → closes pool → stops fixture server → stops mock Ollama → stops webhook receiver

**`waitForJobStatus(jobRepo, jobId, tenantId, targetStatuses, timeoutMs)`:**
```typescript
export async function waitForJobStatus(
  jobRepo: any,
  jobId: string,
  tenantId: string,
  targetStatuses: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await jobRepo.findById(jobId, tenantId);
    if (job && targetStatuses.includes(job.status)) return job.status;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Job ${jobId} did not reach ${targetStatuses.join('|')} within ${timeoutMs}ms`);
}
```

**`waitForExportStatus(exportRepo, exportId, tenantId, targetStatuses, timeoutMs)`:**
Same pattern for export completion polling.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/helpers.ts
git commit -m "feat: add Tier 5A test helpers with startTestWorkers and completion polling"
```

---

## Task 3: Job Lifecycle Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/job-lifecycle.test.ts`

5 tests sharing a single worker harness via `beforeAll`. Tests verify the full job lifecycle: create → start → workers process → complete → entities and schema visible.

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestWorkers, waitForJobStatus, type TestWorkerHarness } from './helpers.js';

let harness: TestWorkerHarness | null = null;
let jobId: string;

beforeAll(async () => {
  harness = await startTestWorkers({
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
  });
  if (!harness) return;

  // Create and start a job — JobManager enqueues seed URLs to BullMQ
  const config = {
    tenantId: harness.tenantId,
    name: 'Tier 5A Test Job',
    description: 'Queue worker integration test',
    seedUrls: [`http://localhost:${harness.fixtureServer.port}/`],
    crawl: { maxDepth: 1, maxPages: 10, concurrency: 1, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const, evolution: { batchSize: 5 } },
    llm: { primaryModel: 'llama3.2:1b' },
  };
  jobId = await harness.jobManager.createJob(config as any);
  await harness.jobManager.startJob(jobId, harness.tenantId);

  // Wait for job to complete (workers process asynchronously)
  await waitForJobStatus(harness.workerDeps.jobRepo, jobId, harness.tenantId, ['completed', 'failed'], 90_000);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
});
```

**Tests:**

1. `Job completes after workers process` — Verify job status is 'completed', not 'failed'
2. `Job has non-zero page count` — Query job stats, verify `pagesCrawled > 0`
3. `Entities created by workers` — `GET /api/v1/jobs/{jobId}/entities` via `harness.app.request()`, verify `data` array non-empty
4. `Schema discovered by workers` — `GET /api/v1/jobs/{jobId}/schema` via `harness.app.request()`, verify schema has fields
5. `Pause and resume job` — Create a second job, start it, pause via `jobManager.pauseJob()`, verify status 'paused', resume, wait for completion

Each test uses `ctx.skip()` if `!harness`.

- [ ] **Step 2: Run tests**

Run: `cd /Users/salar/Projects/spatula/apps/cli && ./node_modules/.bin/vitest run tests/e2e/tier5/tier5a/job-lifecycle.test.ts`
Expected: All 5 skip (no DATABASE_URL) or pass (if Docker running).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/job-lifecycle.test.ts
git commit -m "test: add 5 job lifecycle tests with real BullMQ workers"
```

---

## Task 4: Export Processing Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/export-processing.test.ts`

3 tests. Requires a completed job (from the harness setup). Creates exports via API, waits for worker to process, verifies output.

- [ ] **Step 1: Create the test file**

Setup: same `startTestWorkers` pattern. Create a job, wait for completion. Then run export tests.

**Tests:**

6. `Create export → worker processes → completed` — POST `/api/v1/jobs/{jobId}/export` with `{ format: 'json' }` → poll export status until 'completed' → verify `entityCount > 0`
7. `Download completed export returns content` — After export completes, GET download endpoint → verify non-empty response body
8. `Export with min-quality filter` — Create export with `minQuality: 0.8` → verify `entityCount` is less than total entity count

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/export-processing.test.ts
git commit -m "test: add 3 export processing tests with real BullMQ export worker"
```

---

## Task 5: Webhook Delivery Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/webhook-delivery.test.ts`

3 tests. Creates a job with webhook config, waits for completion, verifies webhook receiver got the POST.

- [ ] **Step 1: Create the test file**

Setup: same `startTestWorkers` pattern. Create a job with:
```typescript
{
  ...config,
  webhooks: {
    url: `http://localhost:${harness.webhookReceiver.port}`,
    events: ['job.completed'],
  },
}
```

**Tests:**

9. `Webhook delivered after job completes` — Start job, wait for completion, then check `harness.webhookReceiver.waitForRequest(10_000)` resolves
10. `Webhook event has correct type and data` — Verify `body.type === 'job.completed'`, `body.data.jobId` matches
11. `Webhook has X-Spatula-Signature with secret` — Create job with `webhooks: { url, secret: 'test-secret-16chars', events: ['job.completed'] }`, verify receiver request has `X-Spatula-Signature` header, compute HMAC-SHA256 and verify match

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/webhook-delivery.test.ts
git commit -m "test: add 3 webhook delivery tests via BullMQ webhook worker"
```

---

## Task 6: DLQ Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/dlq.test.ts`

3 tests using a dedicated test worker that deliberately throws, to test DLQ plumbing.

- [ ] **Step 1: Create the test file**

Setup: Start a minimal BullMQ setup (Redis + DLQ repo + DLQ handler). Create a test queue `spatula.test-dlq` with `attempts: 1` (no retries). Create a worker on that queue whose processor always throws.

```typescript
import { Worker, Queue } from 'bullmq';
import { createDlqHandler, QUEUE_NAMES } from '@spatula/queue';
import { DlqRepository, createDatabasePool } from '@spatula/db';

const TEST_QUEUE_NAME = 'spatula.test-dlq';

// In beforeAll:
const redisConnection = { host: 'localhost', port: 6380, db: 1, maxRetriesPerRequest: null as null };
const { db, pool } = createDatabasePool(process.env.DATABASE_URL!);
const dlqRepo = new DlqRepository(db);
const dlqHandler = createDlqHandler(dlqRepo);

const testQueue = new Queue(TEST_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: { attempts: 1 },
});

const testWorker = new Worker(TEST_QUEUE_NAME, async () => {
  throw new Error('Deliberate test failure');
}, { connection: redisConnection, concurrency: 1 });

testWorker.on('failed', dlqHandler);
```

**Tests:**

12. `Failed job appears in DLQ` — Add job to test queue, wait for worker to process + fail, query `dlqRepo.findUnresolved()`, verify entry exists with error message 'Deliberate test failure'
13. `DLQ retry re-enqueues` — Use the admin API `POST /admin/dlq/:id/retry` (or call `dlqRepo.resolve(id, 'retried')` directly), verify entry resolution is 'retried'
14. `DLQ discard marks resolved` — Call `dlqRepo.resolve(id, 'discarded')`, verify entry resolution is 'discarded'

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/dlq.test.ts
git commit -m "test: add 3 DLQ tests with dedicated test worker"
```

---

## Task 7: State Machine + Quota Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/state-machine.test.ts`

3 tests for state transition enforcement and concurrent job quota.

- [ ] **Step 1: Create the test file**

**Tests:**

15. `Invalid state transition rejected` — Complete a job, then try `jobManager.startJob(jobId, tenantId)` (completed → queued is invalid) → expect `StateError` thrown
16. `Cancel running job → workers stop` — Start a job, wait until 'running', call `jobManager.cancelJob()`, verify status becomes 'cancelled'. Verify no new crawl tasks are processed after cancel (check fixture server request log before and after cancel).
17. `Concurrent job quota enforced` — Start 2 jobs (default quota = 2 concurrent), try to start a 3rd → expect `QuotaExceededError` thrown. Clean up by cancelling the 2 running jobs.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/state-machine.test.ts
git commit -m "test: add 3 state machine and quota enforcement tests"
```

---

## Task 8: Worker Lifecycle + Infrastructure Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/worker-lifecycle.test.ts`

5 tests for graceful shutdown, config diff re-run, WebSocket token, worker heartbeat, and audit logging.

- [ ] **Step 1: Create the test file**

**Tests:**

18. `Worker close mid-job finishes current task` — Start a job, wait until at least 1 crawl task is being processed (poll fixture server request log), call `workers[0].close()` (crawl worker), verify the worker completes cleanly. Check no tasks stuck in `in_progress` state via `taskRepo.getJobStats()`.

19. `Config diff re-run only crawls new URLs` — Complete a first job. Create a second job with an additional seed URL. Start it. Mock Ollama log shows the new URL was classified. The fixture server log shows the new URL was fetched.

20. `WebSocket token endpoint returns valid token` — `POST /api/v1/ws-token` via `harness.app.request()` → 200, response has `data.token` string. Verify token exists in Redis: connect to Redis, `GET ws-token:<token>`, verify it has TTL.

21. `Worker heartbeat in Redis` — After starting workers, connect to Redis, scan for keys matching `worker:heartbeat:*`, verify at least one exists with queue list and timestamp.

22. `Audit log entries for job lifecycle` — After job create/start/cancel sequence, query the audit log table directly via Drizzle, verify entries with `action` values 'job.created', 'job.started', 'job.cancelled'. Note: audit events are written asynchronously via `setImmediate()` — wait 200ms before querying.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/worker-lifecycle.test.ts
git commit -m "test: add 5 worker lifecycle and infrastructure tests"
```

---

## Task 9: Migration Test

**Files:**
- Create: `apps/cli/tests/e2e/tier5/tier5a/migration.test.ts`

1 test verifying that re-running migrations on a database with data doesn't lose data.

- [ ] **Step 1: Create the test file**

**Test:**

23. `Migration preserves existing data` — Insert test data directly via SQL (a job, a schema, an entity). Run `runMigrations(databaseUrl)` again (idempotent). Query the data back. Verify it's still present and unchanged.

Note: `runMigrations` from `@spatula/db` resolves migration paths relative to its own `__dirname`. When called via tsx from the CLI package, use the same workaround from Task 3 of the Tier 4 plan (resolve path via monorepo root). Or since Docker manager already runs migrations on startup, this test just needs to verify data survives a second migration run.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5a/migration.test.ts
git commit -m "test: add migration data preservation test"
```

---

## Task 10: Integration Verification

- [ ] **Step 1: Run Tier 5A tests**

Run: `cd /Users/salar/Projects/spatula/apps/cli && ./node_modules/.bin/vitest run tests/e2e/tier5/tier5a/`
Expected: All 23 tests skip (no Docker) or pass (if Docker + services running).

- [ ] **Step 2: Verify no regression on existing tiers**

Run: `./node_modules/.bin/tsx scripts/test-tiers.ts --tier=2 --yes`
Expected: All Tier 2 tests pass.

- [ ] **Step 3: Type check**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli exec -- tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit if needed**

```bash
git add -A
git commit -m "test: complete Tier 5A queue/worker integration test suite"
```
