/**
 * Tier 5A — Webhook Delivery Tests (Tests 9-11)
 *
 * Verifies that BullMQ webhook worker delivers webhooks after job completion:
 *  - Webhook delivered when job completes
 *  - Webhook event has correct type and data
 *  - Webhook HMAC-SHA256 signature when secret is configured
 *
 * Workers run in-process with mock Ollama + fixture HTTP server.
 * All tests skip gracefully when DATABASE_URL is missing or Playwright unavailable.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestWorkers, waitForJobStatus, type TestWorkerHarness } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let harness: TestWorkerHarness | null = null;
let jobId: string;
let webhookBody: any;

function jobConfig(extra?: Record<string, unknown>) {
  return {
    tenantId: harness!.tenantId,
    name: 'Tier 5A Webhook Test',
    description: 'Webhook delivery integration test',
    seedUrls: [`http://localhost:${harness!.fixtureServer.port}/`],
    crawl: { maxDepth: 1, maxPages: 5, concurrency: 1, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const, evolutionConfig: { enabled: true, batchSize: 5 } },
    llm: { primaryModel: 'llama3.2:1b' },
    ...extra,
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

  // Create a job with webhook config pointing at the webhook receiver
  const config = jobConfig({
    webhooks: {
      url: `http://localhost:${harness.webhookReceiver.port}`,
      events: ['job.completed'],
    },
  });

  jobId = await harness.jobManager.createJob(config as any);
  await harness.jobManager.startJob(jobId, harness.tenantId);

  // Wait for job to reach a terminal state (workers process asynchronously)
  await waitForJobStatus(
    harness.workerDeps.jobRepo,
    jobId,
    harness.tenantId,
    ['completed', 'failed'],
    90_000,
  );

  // Wait for the webhook to be delivered (webhook worker processes async)
  try {
    webhookBody = await harness.webhookReceiver.waitForRequest(15_000);
  } catch {
    // webhookBody remains undefined — test 9 will fail with a clear assertion
  }
}, 120_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Webhook Delivery', () => {
  it('9 — webhook delivered after job completes', (ctx) => {
    if (!harness) return ctx.skip();

    // The job should have completed successfully
    expect(webhookBody).toBeDefined();
    // Verify at least one request was captured by the receiver
    expect(harness.webhookReceiver.requests.length).toBeGreaterThanOrEqual(1);
  });

  it('10 — webhook event has correct type and data', (ctx) => {
    if (!harness) return ctx.skip();
    if (!webhookBody) return ctx.skip();

    // Verify the webhook event structure
    expect(webhookBody.type).toBe('job.completed');
    expect(webhookBody.data).toBeDefined();
    expect(webhookBody.data.jobId).toBe(jobId);
    expect(webhookBody.data.tenantId).toBe(harness.tenantId);
    expect(webhookBody.data.status).toBe('completed');

    // Verify standard event fields
    expect(webhookBody.id).toBeDefined();
    expect(typeof webhookBody.id).toBe('string');
    expect(webhookBody.timestamp).toBeDefined();
  });

  it('11 — webhook has X-Spatula-Signature with secret', async (ctx) => {
    if (!harness) return ctx.skip();

    const secret = 'test-secret-minimum16chars';

    // Create a second webhook receiver to isolate this test's requests
    const { startWebhookReceiver } = await import('../../tier4/helpers.js');
    const signedReceiver = await startWebhookReceiver();

    try {
      // Create a job with webhook config that includes a secret
      const config = jobConfig({
        name: 'Tier 5A Webhook Signature Test',
        webhooks: {
          url: `http://localhost:${signedReceiver.port}`,
          events: ['job.completed'],
          secret,
        },
      });

      const signedJobId = await harness.jobManager.createJob(config as any);
      await harness.jobManager.startJob(signedJobId, harness.tenantId);

      // Wait for job to complete
      await waitForJobStatus(
        harness.workerDeps.jobRepo,
        signedJobId,
        harness.tenantId,
        ['completed', 'failed'],
        90_000,
      );

      // Wait for the signed webhook delivery
      const body = await signedReceiver.waitForRequest(15_000);
      expect(body).toBeDefined();

      // Verify the X-Spatula-Signature header is present
      const lastReq = signedReceiver.requests[signedReceiver.requests.length - 1];
      const sigHeader = lastReq.headers['x-spatula-signature'];
      expect(sigHeader).toBeDefined();
      expect(sigHeader).toMatch(/^sha256=/);

      // Compute the expected HMAC-SHA256 and verify it matches
      // WebhookSender computes: createHmac('sha256', secret).update(JSON.stringify(event)).digest('hex')
      const expectedSignature = createHmac('sha256', secret)
        .update(JSON.stringify(lastReq.body))
        .digest('hex');
      expect(sigHeader).toBe(`sha256=${expectedSignature}`);
    } finally {
      await signedReceiver.close();
    }
  });
});
