/**
 * Tier 5A — Dead Letter Queue (DLQ) Integration Tests
 *
 * Tests 12-14: Verifies that failed jobs land in the DLQ table and can be
 * resolved (retried / discarded).
 *
 * IMPORTANT: These tests use a dedicated test BullMQ worker that deliberately
 * throws — they do NOT rely on the production crawl worker (which catches all
 * errors silently).
 *
 * Setup:
 *  - Real Postgres (DlqRepository)
 *  - Real Redis (BullMQ)
 *  - Dedicated test queue `spatula.test-dlq` with attempts: 1 (no retries)
 *  - Dedicated test worker whose processor always throws
 *  - DLQ handler wired to the test worker's `failed` event
 *
 * All tests skip gracefully when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabasePool, DlqRepository } from '@spatula/db';
import { createDlqHandler } from '@spatula/queue';

// BullMQ is loaded dynamically to avoid Vite resolution issues
// (bullmq is installed inside @spatula/queue, not hoisted to CLI)
type BullMQQueue = import('bullmq').Queue;
type BullMQWorker = import('bullmq').Worker;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_QUEUE_NAME = 'spatula.test-dlq';

const REDIS_CONNECTION = {
  host: 'localhost',
  port: 6380,
  db: 1,
  maxRetriesPerRequest: null as null,
};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let dbAvailable = false;
let pool: { end(): Promise<void> };
let dlqRepo: DlqRepository;
let testQueue: BullMQQueue;
let testWorker: BullMQWorker;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return; // all tests will skip

  dbAvailable = true;

  // 1. Postgres pool + DlqRepository
  const dbResult = createDatabasePool(databaseUrl);
  pool = dbResult.pool;
  dlqRepo = new DlqRepository(dbResult.db);

  // 2. Dynamic import of bullmq to avoid Vite transform errors
  const bullmqModule = 'bullmq';
  const { Queue, Worker } = await import(/* @vite-ignore */ bullmqModule);

  // 3. BullMQ test queue (attempts: 1 = immediate DLQ on failure)
  testQueue = new Queue(TEST_QUEUE_NAME, {
    connection: REDIS_CONNECTION,
    defaultJobOptions: { attempts: 1 },
  });

  // 4. DLQ handler
  const dlqHandler = createDlqHandler(dlqRepo);

  // 5. Dedicated test worker that always throws
  testWorker = new Worker(
    TEST_QUEUE_NAME,
    async () => {
      throw new Error('Deliberate test failure');
    },
    { connection: REDIS_CONNECTION, concurrency: 1 },
  );

  // 6. Wire DLQ handler to the worker's failed event
  testWorker.on('failed', dlqHandler);
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;

  // Clean up in dependency order: worker -> queue -> pool
  if (testWorker) await testWorker.close().catch(() => {});
  if (testQueue) await testQueue.close().catch(() => {});
  if (pool) await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the test worker to fail the given BullMQ job.
 * Resolves once the `failed` event fires for a job whose id matches.
 */
function waitForWorkerFailed(jobId: string, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Worker did not fail job ${jobId} within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const handler = (failedJob: any) => {
      if (failedJob?.id === jobId) {
        clearTimeout(timer);
        testWorker.removeListener('failed', handler);
        // Give the DLQ handler time to insert (it's async in the same event)
        setTimeout(resolve, 500);
      }
    };

    testWorker.on('failed', handler);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tier 5A — DLQ (Tests 12-14)', () => {
  // -------------------------------------------------------------------------
  // Test 12: Failed job appears in DLQ
  // -------------------------------------------------------------------------
  it('12. Failed job appears in DLQ', async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Add a job to the test queue
    // NOTE: tenantId and jobId (spatulaJobId) must be omitted because the DLQ
    // table defines them as uuid columns with FK constraints. Non-UUID strings
    // like 'test' or 'test-job-1' would violate the FK and cause insert failure.
    const job = await testQueue.add('test-job', {
      payload: 'test-job-1',
    });

    // Wait for the worker to process + fail the job
    await waitForWorkerFailed(job.id!);

    // Query unresolved DLQ entries for our test queue
    const entries = await dlqRepo.findUnresolved({ queueName: TEST_QUEUE_NAME });

    // Verify at least one entry matches our job
    const match = entries.find((e) => e.jobId === job.id);
    expect(match).toBeDefined();
    expect(match!.errorMessage).toContain('Deliberate test failure');
    expect(match!.queueName).toBe(TEST_QUEUE_NAME);
    expect(match!.resolvedAt).toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 13: DLQ retry resolves entry
  // -------------------------------------------------------------------------
  it('13. DLQ retry resolves entry', async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Find the unresolved DLQ entry from Test 12
    const entries = await dlqRepo.findUnresolved({ queueName: TEST_QUEUE_NAME });
    expect(entries.length).toBeGreaterThan(0);

    const entryId = entries[0].id;

    // Resolve as 'retried'
    const resolved = await dlqRepo.resolve(entryId, 'retried');

    expect(resolved.resolution).toBe('retried');
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.id).toBe(entryId);

    // NOTE: Re-enqueue verification requires the admin API route
    // (POST /api/v1/admin/dlq/:id/retry) which both re-enqueues AND resolves.
    // The current test calls dlqRepo.resolve() directly, which only changes
    // the status without re-enqueuing. This is a known simplification accepted
    // in the plan — full re-enqueue verification belongs in an API-level test.
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test 14: DLQ discard marks resolved
  // -------------------------------------------------------------------------
  it('14. DLQ discard marks resolved', async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Create another failing job (omit tenantId/jobId — not valid UUIDs for FK)
    const job = await testQueue.add('test-job', {
      payload: 'test-job-2',
    });

    // Wait for the worker to fail this new job
    await waitForWorkerFailed(job.id!);

    // Find the new unresolved DLQ entry
    const entries = await dlqRepo.findUnresolved({ queueName: TEST_QUEUE_NAME });
    const match = entries.find((e) => e.jobId === job.id);
    expect(match).toBeDefined();

    // Resolve as 'discarded'
    const resolved = await dlqRepo.resolve(match!.id, 'discarded');

    expect(resolved.resolution).toBe('discarded');
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.id).toBe(match!.id);

    // Verify it no longer appears in unresolved list
    const remaining = await dlqRepo.findUnresolved({ queueName: TEST_QUEUE_NAME });
    const stillPresent = remaining.find((e) => e.id === match!.id);
    expect(stillPresent).toBeUndefined();
  }, 30_000);
});
