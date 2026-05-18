/**
 * Tier 5A — Export Processing Tests (Tests 6-8)
 *
 * Verifies the BullMQ export worker processes exports end-to-end:
 *  - Create export via API -> worker processes -> completed
 *  - Download completed export content
 *  - Export with min-quality filter reduces entity count
 *
 * Requires: Docker (Postgres + Redis), Playwright, mock Ollama
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startTestWorkers,
  waitForJobStatus,
  waitForExportStatus,
  type TestWorkerHarness,
} from './helpers.js';

let harness: TestWorkerHarness | null = null;
let jobId: string;
let completedExportId: string;
let totalEntityCount: number;

beforeAll(async () => {
  harness = await startTestWorkers({
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
  });
  if (!harness) return;

  // Create and start a job — workers process crawl/extract/evolve/reconcile
  const config = {
    tenantId: harness.tenantId,
    name: 'Tier 5A Export Test Job',
    description: 'Export processing integration test',
    seedUrls: [`http://localhost:${harness.fixtureServer.port}/`],
    crawl: { maxDepth: 1, maxPages: 10, concurrency: 1, crawlerType: 'playwright' as const },
    schema: { mode: 'discovery' as const, evolutionConfig: { enabled: true, batchSize: 5 } },
    llm: { primaryModel: 'llama3.2:1b' },
  };
  jobId = await harness.jobManager.createJob(config as any);
  await harness.jobManager.startJob(jobId, harness.tenantId);

  // Wait for job to complete so entities exist for export
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

describe('Export Processing', () => {
  // ------------------------------------------------------------------
  // Test 6: Create export -> worker processes -> completed
  // ------------------------------------------------------------------
  it('creates export via API and worker processes to completed', async (ctx) => {
    if (!harness) return ctx.skip();

    const res = await harness.app.request(`/api/v1/jobs/${jobId}/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': harness.tenantId,
      },
      body: JSON.stringify({ format: 'json' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBeDefined();
    expect(body.data.format).toBe('json');

    const exportId = body.data.id;

    // Poll export status until completed (worker processes asynchronously)
    const finalStatus = await waitForExportStatus(
      harness.workerDeps.exportRepo,
      exportId,
      harness.tenantId,
      ['completed', 'failed'],
      60_000,
    );

    expect(finalStatus).toBe('completed');

    // Verify entityCount > 0 via the get-export endpoint
    const statusRes = await harness.app.request(`/api/v1/jobs/${jobId}/export/${exportId}`, {
      method: 'GET',
      headers: { 'x-tenant-id': harness.tenantId },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.data.entityCount).toBeGreaterThan(0);

    // Store exportId for the download test
    completedExportId = exportId;
    totalEntityCount = statusBody.data.entityCount;
  }, 90_000);

  // ------------------------------------------------------------------
  // Test 7: Download completed export returns content
  // ------------------------------------------------------------------
  it('downloads completed export with non-empty content', async (ctx) => {
    if (!harness) return ctx.skip();

    const exportId = completedExportId;
    expect(exportId).toBeDefined();

    const res = await harness.app.request(`/api/v1/jobs/${jobId}/export/${exportId}/download`, {
      method: 'GET',
      headers: { 'x-tenant-id': harness.tenantId },
    });

    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');

    const disposition = res.headers.get('content-disposition');
    expect(disposition).toContain('attachment');

    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);

    // Verify it parses as valid JSON
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true);
  }, 30_000);

  // ------------------------------------------------------------------
  // Test 8: Export with min-quality filter
  // ------------------------------------------------------------------
  it('export with minQuality filter has fewer entities than total', async (ctx) => {
    if (!harness) return ctx.skip();

    expect(totalEntityCount).toBeGreaterThan(0);

    // Create export with high minQuality filter
    const res = await harness.app.request(`/api/v1/jobs/${jobId}/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': harness.tenantId,
      },
      body: JSON.stringify({ format: 'json', minQuality: 0.8 }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    const filteredExportId = body.data.id;

    // Wait for export worker to process
    const finalStatus = await waitForExportStatus(
      harness.workerDeps.exportRepo,
      filteredExportId,
      harness.tenantId,
      ['completed', 'failed'],
      60_000,
    );

    expect(finalStatus).toBe('completed');

    // Verify filtered entityCount is less than the unfiltered total
    const statusRes = await harness.app.request(
      `/api/v1/jobs/${jobId}/export/${filteredExportId}`,
      {
        method: 'GET',
        headers: { 'x-tenant-id': harness.tenantId },
      },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();

    // The filtered count should be strictly less than the unfiltered total
    // (mock Ollama produces entities with varying quality scores)
    expect(statusBody.data.entityCount).toBeLessThan(totalEntityCount);
  }, 90_000);
});
