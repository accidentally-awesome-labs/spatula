import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenant } from '../../tier4/helpers.js';
import {
  setupAuthContext,
  bearerHeaders,
  createApiKeyDirectly,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Rate Limiting', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;

    // Flush Redis to prevent stale rate limit counters from prior runs
    if (ctx.redis) await ctx.redis.flushdb();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 19: 61 rapid requests → 61st returns 429 ────────────────
  it('returns 429 after exceeding free-tier rate limit (60/min)', async (t) => {
    if (!dbAvailable || !ctx.redis) return t.skip();

    // Dedicated tenant to avoid cross-test pollution
    const { tenantId } = await createTenant(ctx.app, 'Rate Limit Test');
    const { rawKey } = await createApiKeyDirectly(ctx.db, tenantId, ['jobs:read'], 'rate-key');

    let got429 = false;
    for (let i = 0; i < 61; i++) {
      const res = await ctx.app.request('/api/v1/jobs', {
        headers: bearerHeaders(rawKey),
      });
      if (res.status === 429) {
        const body = await res.json();
        expect(body.error.code).toBe('RATE_LIMIT_ERROR');
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
    const { rawKey: keyA } = await createApiKeyDirectly(ctx.db, tA, ['jobs:read'], 'rate-a');
    const { tenantId: tB } = await createTenant(ctx.app, 'Rate B');
    const { rawKey: keyB } = await createApiKeyDirectly(ctx.db, tB, ['jobs:read'], 'rate-b');

    // Exhaust tenant A's limit
    for (let i = 0; i < 61; i++) {
      await ctx.app.request('/api/v1/jobs', { headers: bearerHeaders(keyA) });
    }

    // Tenant B should still succeed
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(keyB),
    });
    expect(res.status).toBe(200);
  }, 30_000);
});
