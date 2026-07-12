import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ErrorCode } from '@spatula/shared';
import { createTenant } from '../../tier4/helpers.js';
import {
  setupAuthContext,
  bearerHeaders,
  createApiKeyDirectly,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

const JOB_CREATE_LIMIT_PER_MINUTE = 30;

describe('Tier 5B: Rate Limiting', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;

    // Clear stale rate limit counters from prior runs (targeted, not flushdb)
    if (ctx.redis) {
      const keys = await ctx.redis.keys('ratelimit:*');
      if (keys.length > 0) await ctx.redis.del(...keys);
    }
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 19: configured job-create limit + 1 rapid requests returns 429 ──
  it('returns 429 after exceeding configured job-create rate limit', async (t) => {
    if (!dbAvailable || !ctx.redis) return t.skip();

    // Dedicated tenant to avoid cross-test pollution
    const { tenantId } = await createTenant(ctx.app, 'Rate Limit Test');
    const { rawKey } = await createApiKeyDirectly(ctx.db, tenantId, ['jobs:write'], 'rate-key');

    let got429 = false;
    for (let i = 0; i < JOB_CREATE_LIMIT_PER_MINUTE + 1; i++) {
      const res = await ctx.app.request('/api/v1/jobs', {
        method: 'POST',
        headers: bearerHeaders(rawKey),
        body: JSON.stringify(minimalJobBody({ name: `Rate Limit Job ${i}` })),
      });
      if (res.status === 429) {
        const body = await res.json();
        expect(body.error.code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
        expect(res.headers.get('Retry-After')).toBe('60');
        expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  }, 30_000);

  // ── Test 20: Rate limit per-tenant ────────────────────────────────
  it('rate limits independently per tenant', async (t) => {
    if (!dbAvailable || !ctx.redis) return t.skip();

    // Two fresh tenants
    const { tenantId: tA } = await createTenant(ctx.app, 'Rate A');
    const { rawKey: keyA } = await createApiKeyDirectly(ctx.db, tA, ['jobs:write'], 'rate-a');
    const { tenantId: tB } = await createTenant(ctx.app, 'Rate B');
    const { rawKey: keyB } = await createApiKeyDirectly(ctx.db, tB, ['jobs:write'], 'rate-b');

    // Exhaust tenant A's limit
    let tenantAThrottled = false;
    for (let i = 0; i < JOB_CREATE_LIMIT_PER_MINUTE + 1; i++) {
      const res = await ctx.app.request('/api/v1/jobs', {
        method: 'POST',
        headers: bearerHeaders(keyA),
        body: JSON.stringify(minimalJobBody({ name: `Tenant A Rate Job ${i}` })),
      });
      if (res.status === 429) {
        tenantAThrottled = true;
        break;
      }
    }
    expect(tenantAThrottled).toBe(true);

    // Tenant B should still succeed on the same route.
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(keyB),
      body: JSON.stringify(minimalJobBody({ name: 'Tenant B Rate Check' })),
    });
    expect(res.status).toBe(201);
  }, 30_000);
});
