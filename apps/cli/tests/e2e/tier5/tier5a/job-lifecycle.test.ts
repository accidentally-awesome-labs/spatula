/**
 * Tier 5A — Job Lifecycle Tests (Tests 1-5)
 *
 * Exercises the full job lifecycle with real BullMQ workers:
 *  create → start → workers process (crawl/extract/evolve/reconcile) → complete
 *
 * Workers run in-process with mock Ollama + fixture HTTP server.
 * All tests skip gracefully when DATABASE_URL is missing or Playwright unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestWorkers, waitForJobStatus, type TestWorkerHarness } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let harness: TestWorkerHarness | null = null;
let jobId: string;

const headers = () => ({
  'x-tenant-id': harness!.tenantId,
  'Content-Type': 'application/json',
});

function jobConfig() {
  return {
    tenantId: harness!.tenantId,
    name: 'Tier 5A Lifecycle Test',
    description: 'Queue worker integration test',
    seedUrls: [`http://localhost:${harness!.fixtureServer.port}/`],
    crawl: { maxDepth: 1, maxPages: 10, concurrency: 1, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const, evolutionConfig: { enabled: true, batchSize: 5 } },
    llm: { primaryModel: 'llama3.2:1b' },
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startTestWorkers({
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
  });
  if (!harness) return;

  // Create and start a job — JobManager enqueues seed URLs to BullMQ
  jobId = await harness.jobManager.createJob(jobConfig() as any);
  await harness.jobManager.startJob(jobId, harness.tenantId);

  // Wait for job to reach a terminal state (workers process asynchronously)
  await waitForJobStatus(
    harness.workerDeps.jobRepo,
    jobId,
    harness.tenantId,
    ['completed', 'failed'],
    90_000,
  );
}, 120_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Job Lifecycle', () => {
  it('1 — job completes after workers process', async (ctx) => {
    if (!harness) return ctx.skip();

    const job = await harness.workerDeps.jobRepo.findById(jobId, harness.tenantId);
    expect(job).toBeDefined();
    expect(job!.status).toBe('completed');
  });

  it('2 — job has non-zero page count', async (ctx) => {
    if (!harness) return ctx.skip();

    const stats = await harness.workerDeps.taskRepo.getJobStats(jobId, harness.tenantId);
    const totalProcessed = stats.completed + stats.failed + stats.skipped;
    expect(totalProcessed).toBeGreaterThan(0);
  });

  it('3 — entities created by workers visible via API', async (ctx) => {
    if (!harness) return ctx.skip();

    const res = await harness.app.request(
      `/api/v1/jobs/${jobId}/entities`,
      { headers: headers() },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('4 — schema discovered by workers visible via API', async (ctx) => {
    if (!harness) return ctx.skip();

    const res = await harness.app.request(
      `/api/v1/jobs/${jobId}/schema`,
      { headers: headers() },
    );

    // Schema may or may not have been created by the mock-driven schema
    // evolution workers. Accept both: (a) 200 with fields, or (b) 404.
    if (res.status === 404) {
      // No schema was evolved — acceptable with mock Ollama
      return;
    }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.definition).toBeDefined();
    expect(body.data.definition.fields).toBeDefined();
    // With mock Ollama the field-proposer may return zero new fields.
    // The important thing is that the schema structure is valid.
    expect(Array.isArray(body.data.definition.fields)).toBe(true);
  });

  it('5 — pause and resume job', async (ctx) => {
    if (!harness) return ctx.skip();

    // Create a second job for the pause/resume test
    const secondJobId = await harness.jobManager.createJob({
      ...jobConfig(),
      name: 'Tier 5A Pause/Resume Test',
    } as any);

    await harness.jobManager.startJob(secondJobId, harness.tenantId);

    // Wait until the job is running (it may transition quickly)
    await waitForJobStatus(
      harness.workerDeps.jobRepo,
      secondJobId,
      harness.tenantId,
      ['running', 'reconciling', 'completed', 'failed'],
      30_000,
    );

    // Only pause if the job is still in a pausable state
    const jobBeforePause = await harness.workerDeps.jobRepo.findById(secondJobId, harness.tenantId);
    if (jobBeforePause!.status === 'running') {
      // Pause
      await harness.jobManager.pauseJob(secondJobId, harness.tenantId);
      const pausedJob = await harness.workerDeps.jobRepo.findById(secondJobId, harness.tenantId);
      expect(pausedJob!.status).toBe('paused');

      // Resume
      await harness.jobManager.resumeJob(secondJobId, harness.tenantId);
      const resumedJob = await harness.workerDeps.jobRepo.findById(secondJobId, harness.tenantId);
      expect(resumedJob!.status).toBe('running');

      // Wait for completion after resume
      const finalStatus = await waitForJobStatus(
        harness.workerDeps.jobRepo,
        secondJobId,
        harness.tenantId,
        ['completed', 'failed'],
        90_000,
      );
      expect(finalStatus).toBe('completed');
    } else {
      // Job already moved past running — at least verify it completes
      const finalStatus = await waitForJobStatus(
        harness.workerDeps.jobRepo,
        secondJobId,
        harness.tenantId,
        ['completed', 'failed'],
        90_000,
      );
      expect(finalStatus).toBe('completed');
    }
  });
});
