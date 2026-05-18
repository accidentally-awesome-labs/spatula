import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupAuthContext,
  bearerHeaders,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Idempotency', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;

    // Clear stale idempotency keys from prior runs (targeted, not flushdb)
    if (ctx.redis) {
      const keys = await ctx.redis.keys('idempotency:*');
      if (keys.length > 0) await ctx.redis.del(...keys);
    }
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  function skipIfNoDB(t: { skip: () => void }) {
    if (!dbAvailable) t.skip();
  }
  function skipIfNoRedis(t: { skip: () => void }) {
    if (!dbAvailable || !ctx.redis) t.skip();
  }

  // Shared state for tests 15-17 (sequential within describe)
  const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let firstJobId: string;

  // ── Test 15: POST with Idempotency-Key → 201 ─────────────────────
  it('POST with Idempotency-Key creates resource', async (t) => {
    skipIfNoRedis(t);
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Idempotent Job' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    firstJobId = body.data.id;
    expect(firstJobId).toBeDefined();
  });

  // ── Test 16: Same key again → cached 201 (no duplicate) ──────────
  it('same Idempotency-Key returns cached response', async (t) => {
    skipIfNoRedis(t);
    if (!firstJobId) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Idempotent Job' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(firstJobId); // Same ID — cached, not new
  });

  // ── Test 17: Same key, different body → cached response ───────────
  it('same Idempotency-Key ignores different body', async (t) => {
    skipIfNoRedis(t);
    if (!firstJobId) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Completely Different Name' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(firstJobId); // Still cached original
  });

  // ── Test 18: Idempotency only applies to POST/PATCH ───────────────
  it('ignores Idempotency-Key on DELETE', async (t) => {
    skipIfNoDB(t);
    // Create a job to delete
    const createRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody({ name: 'Delete Target' })),
    });
    const { data: job } = await createRes.json();
    const deleteKey = `del-${Date.now()}`;

    // First DELETE with Idempotency-Key → 204 (job deleted, no content)
    // Note: DELETE returns 204 with no body. The idempotency middleware only
    // caches JSON 2xx responses, so 204 is never cached regardless of method filter.
    const del1 = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      method: 'DELETE',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': deleteKey },
    });
    expect(del1.status).toBe(204);

    // Second DELETE with same key → 404 (proves NOT cached)
    const del2 = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      method: 'DELETE',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': deleteKey },
    });
    expect(del2.status).toBe(404);
  });
});
