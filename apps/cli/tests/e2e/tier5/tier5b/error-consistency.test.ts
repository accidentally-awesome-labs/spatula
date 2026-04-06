import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupAuthContext, bearerHeaders, minimalJobBody, type AuthTestContext } from './helpers.js';

describe('Tier 5B: Error Response Consistency', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 21: 400 validation error format ──────────────────────────
  it('returns 400 VALIDATION_ERROR for invalid body', async (t) => {
    if (!dbAvailable) return t.skip();
    // POST a job with missing required fields
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'only name, missing everything' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBeDefined();
  });

  // ── Test 22: 404 not found format ─────────────────────────────────
  it('returns 404 NOT_FOUND for nonexistent job', async (t) => {
    if (!dbAvailable) return t.skip();
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ctx.app.request(`/api/v1/jobs/${fakeId}`, {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeDefined();
    expect(body.error.requestId).toBeDefined();
  });

  // ── Test 23: 409 conflict format (DLQ already resolved) ──────────
  it('returns 409 for already-resolved DLQ entry', async (t) => {
    if (!dbAvailable) return t.skip();
    // Insert a DLQ entry directly
    const { id: dlqId } = await ctx.repos.dlqRepo.insert({
      queueName: 'spatula.test',
      jobId: 'test-bull-job-id',
      tenantId: ctx.tenantId,
      payload: { test: true },
      errorMessage: 'test failure',
      attempts: 1,
    });

    // First discard → 200
    const res1 = await ctx.app.request(`/api/v1/admin/dlq/${dlqId}/discard`, {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res1.status).toBe(200);

    // Second discard → 409 (already resolved)
    const res2 = await ctx.app.request(`/api/v1/admin/dlq/${dlqId}/discard`, {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body.error.code).toBe('ALREADY_RESOLVED');
    expect(body.error.message).toBeDefined();
  });

  // ── Test 24: 500 unhandled exception format ───────────────────────
  it('returns 500 INTERNAL_ERROR for unhandled exceptions', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a job first (before the spy) so we have a valid ID
    const createRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody()),
    });
    const { data: job } = await createRes.json();

    // Now spy on findById to throw — set up AFTER job creation to avoid
    // accidental consumption by unrelated middleware calls
    const spy = vi.spyOn(ctx.repos.jobRepo, 'findById').mockRejectedValueOnce(
      new Error('database exploded'),
    );

    const res = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error'); // Generic for 5xx
    expect(body.error.requestId).toBeDefined();

    spy.mockRestore();
  });

  // ── Test 25: POST with wrong Content-Type ─────────────────────────
  it('rejects POST with wrong Content-Type', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'text/plain',
      },
      body: 'this is not json',
    });
    // Should be 400 (parse/validation error) or 415 (unsupported media type)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
