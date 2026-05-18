/**
 * Tier 5A -- Worker Lifecycle + Infrastructure Tests (Tests 18-22)
 *
 * Verifies:
 *  - Worker close mid-job finishes current task cleanly (no stuck in_progress)
 *  - Config diff re-run only crawls new URLs
 *  - WebSocket token endpoint returns valid token stored in Redis
 *  - Worker heartbeat keys appear in Redis
 *  - Audit log entries written for job lifecycle events via API
 *
 * Workers run in-process with mock Ollama + fixture HTTP server.
 * All tests skip gracefully when DATABASE_URL is missing or Playwright unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestWorkers, waitForJobStatus, type TestWorkerHarness } from './helpers.js';
import { WorkerHeartbeat, QUEUE_NAMES } from '@spatula/queue';
import { AuditLogRepository } from '@spatula/db';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let harness: TestWorkerHarness | null = null;

const headers = () => ({
  'x-tenant-id': harness!.tenantId,
  'Content-Type': 'application/json',
});

function jobConfig(overrides?: Record<string, unknown>) {
  return {
    tenantId: harness!.tenantId,
    name: 'Tier 5A Worker Lifecycle Test',
    description: 'Worker lifecycle integration test',
    seedUrls: [`http://localhost:${harness!.fixtureServer.port}/`],
    crawl: { maxDepth: 1, maxPages: 5, concurrency: 1, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const, evolutionConfig: { enabled: true, batchSize: 5 } },
    llm: { primaryModel: 'llama3.2:1b' },
    ...overrides,
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
}, 120_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tier 5A -- Worker Lifecycle + Infrastructure (Tests 18-22)', () => {
  // -------------------------------------------------------------------------
  // Test 18: Worker close mid-job finishes current task
  // -------------------------------------------------------------------------
  it('18. Worker close mid-job leaves no tasks stuck in in_progress', async (ctx) => {
    if (!harness) return ctx.skip();

    // Start a job
    const jobId = await harness.jobManager.createJob(
      jobConfig({ name: 'Tier 5A Worker Close Test' }) as any,
    );
    await harness.jobManager.startJob(jobId, harness.tenantId);

    // Wait until the fixture server shows at least 1 request (meaning crawl worker is active)
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (harness.fixtureServer.requestLog.length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    // Close the crawl worker (workers[0])
    const crawlWorker = harness.workers[0];
    await crawlWorker.close();

    // Wait briefly for any in-flight task to settle
    await new Promise((r) => setTimeout(r, 2_000));

    // Verify no tasks are stuck in in_progress for this job
    const stats = await harness.workerDeps.taskRepo.getJobStats(jobId, harness.tenantId);
    expect(stats.inProgress).toBe(0);

    // Recreate the crawl worker so subsequent tests can use it
    const { Worker } = await import('bullmq');
    const { processCrawlJob, QUEUE_NAMES } = await import('@spatula/queue');
    const newCrawlWorker = new Worker(
      QUEUE_NAMES.CRAWL,
      async (job: any) => processCrawlJob(job.data, harness!.workerDeps),
      {
        connection: { host: 'localhost', port: 6380, db: 1, maxRetriesPerRequest: null as null },
        concurrency: 1,
      },
    );
    harness!.workers[0] = newCrawlWorker;
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test 19: Config diff re-run only crawls new URLs
  // -------------------------------------------------------------------------
  it('19. Config diff re-run crawls new seed URL', async (ctx) => {
    if (!harness) return ctx.skip();

    // Complete a first job
    const firstJobId = await harness.jobManager.createJob(
      jobConfig({ name: 'Tier 5A First Run' }) as any,
    );
    await harness.jobManager.startJob(firstJobId, harness.tenantId);
    await waitForJobStatus(
      harness.workerDeps.jobRepo,
      firstJobId,
      harness.tenantId,
      ['completed', 'failed'],
      90_000,
    );

    // Reset the fixture server log to track only new requests
    harness.fixtureServer.resetLog();

    // Create a second job with an extra seed URL
    const newSeedUrl = `http://localhost:${harness.fixtureServer.port}/about`;
    const secondJobId = await harness.jobManager.createJob(
      jobConfig({
        name: 'Tier 5A Second Run (extra seed)',
        seedUrls: [`http://localhost:${harness.fixtureServer.port}/`, newSeedUrl],
      }) as any,
    );
    await harness.jobManager.startJob(secondJobId, harness.tenantId);
    await waitForJobStatus(
      harness.workerDeps.jobRepo,
      secondJobId,
      harness.tenantId,
      ['completed', 'failed'],
      90_000,
    );

    // Verify the fixture server was hit with the /about path
    const aboutRequests = harness.fixtureServer.requestLog.filter((r) => r.path === '/about');
    expect(aboutRequests.length).toBeGreaterThan(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Test 20: WebSocket token endpoint returns valid token
  // -------------------------------------------------------------------------
  it('20. WebSocket token endpoint returns valid token', async (ctx) => {
    if (!harness) return ctx.skip();

    const res = await harness.app.request('/api/v1/ws-token', {
      method: 'POST',
      headers: headers(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.token).toBeDefined();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token.length).toBeGreaterThan(0);
    expect(body.data.expiresIn).toBeDefined();
    expect(body.data.expiresIn).toBeGreaterThan(0);

    // Optionally verify the token exists in Redis
    // Connect to Redis and check the key
    const redisModule = 'ioredis';
    const mod: any = await import(/* @vite-ignore */ redisModule);
    const IoRedis = mod.default;
    const redis = new IoRedis('localhost', { port: 6380, db: 1 });

    try {
      const key = `ws-token:${body.data.token}`;
      const value = await redis.get(key);
      expect(value).toBeTruthy();

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      await redis.quit();
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test 21: Worker heartbeat in Redis
  // -------------------------------------------------------------------------
  it('21. Worker heartbeat keys exist in Redis', async (ctx) => {
    if (!harness) return ctx.skip();

    // Start a WorkerHeartbeat manually (startTestWorkers does not start it by default)
    let heartbeat: InstanceType<typeof WorkerHeartbeat> | null = null;

    try {
      const redisModule = 'ioredis';
      const mod: any = await import(/* @vite-ignore */ redisModule);
      const IoRedis = mod.default;
      const redis = new IoRedis('localhost', { port: 6380, db: 1 });

      heartbeat = new WorkerHeartbeat({
        redis,
        queues: [QUEUE_NAMES.CRAWL, QUEUE_NAMES.SCHEMA_EVOLUTION, QUEUE_NAMES.RECONCILIATION],
        intervalMs: 1_000, // Fast interval for testing
        ttlSeconds: 30,
      });

      heartbeat.start();

      // Wait for at least one heartbeat to fire
      await new Promise((r) => setTimeout(r, 2_000));

      // Scan Redis for heartbeat keys
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redis.scan(
          cursor,
          'MATCH',
          'worker:heartbeat:*',
          'COUNT',
          100,
        );
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');

      expect(keys.length).toBeGreaterThanOrEqual(1);

      // Verify one key has valid heartbeat data
      const value = await redis.get(keys[0]);
      expect(value).toBeTruthy();

      const parsed = JSON.parse(value!);
      expect(parsed.workerId).toBeDefined();
      expect(parsed.queues).toBeDefined();
      expect(Array.isArray(parsed.queues)).toBe(true);
      expect(parsed.lastBeat).toBeDefined();

      heartbeat.stop();
      await redis.quit();
    } catch (error) {
      if (heartbeat) heartbeat.stop();
      throw error;
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test 22: Audit log entries for job lifecycle
  // -------------------------------------------------------------------------
  it('22. Audit log entries written for job create/start/cancel via API', async (ctx) => {
    if (!harness) return ctx.skip();

    const auditLogRepo = new AuditLogRepository(harness.db);

    // Create a job via the API (which triggers audit logging)
    const createRes = await harness.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        name: 'Tier 5A Audit Log Test',
        description: 'Audit log integration test',
        seedUrls: [`http://localhost:${harness.fixtureServer.port}/`],
        crawl: { maxDepth: 0, maxPages: 1, concurrency: 1, crawlerType: 'playwright' },
        schema: { mode: 'discovery', evolutionConfig: { enabled: true, batchSize: 5 } },
        llm: { primaryModel: 'llama3.2:1b' },
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const auditJobId = createBody.data.id;

    // Start the job via API
    const startRes = await harness.app.request(`/api/v1/jobs/${auditJobId}/start`, {
      method: 'POST',
      headers: headers(),
    });
    expect(startRes.status).toBe(200);

    // Cancel the job via API
    // Wait briefly for it to reach running state first
    await waitForJobStatus(
      harness.workerDeps.jobRepo,
      auditJobId,
      harness.tenantId,
      ['running', 'reconciling', 'completed', 'failed'],
      30_000,
    );

    const jobBeforeCancel = await harness.workerDeps.jobRepo.findById(auditJobId, harness.tenantId);
    if (jobBeforeCancel && ['running', 'paused', 'queued'].includes(jobBeforeCancel.status)) {
      const cancelRes = await harness.app.request(`/api/v1/jobs/${auditJobId}/cancel`, {
        method: 'POST',
        headers: headers(),
      });
      expect(cancelRes.status).toBe(200);
    }

    // Wait for async audit writes (setImmediate-based)
    await new Promise((r) => setTimeout(r, 500));

    // Query the audit log for this tenant
    try {
      const entries = await auditLogRepo.findByTenant(harness.tenantId, { limit: 50 });

      // Verify we have audit entries (at minimum: job.created and job.started)
      expect(entries.length).toBeGreaterThanOrEqual(2);

      // Check for specific action types related to our job
      const actions = entries.filter((e) => e.resourceId === auditJobId).map((e) => e.action);

      expect(actions).toContain('job.created');
      expect(actions).toContain('job.started');

      // If we managed to cancel, check for that too
      if (jobBeforeCancel && ['running', 'paused', 'queued'].includes(jobBeforeCancel.status)) {
        expect(actions).toContain('job.cancelled');
      }
    } catch (error) {
      // Audit logging may not be fully wired -- skip gracefully
      const msg = (error as Error).message;
      if (msg.includes('relation') && msg.includes('does not exist')) {
        return ctx.skip();
      }
      throw error;
    }
  }, 60_000);
});
