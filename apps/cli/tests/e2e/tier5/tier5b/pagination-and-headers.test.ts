import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupAuthContext, bearerHeaders, type AuthTestContext } from './helpers.js';

describe('Tier 5B: Pagination Edge Cases & Security Headers', () => {
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

  // ── Test 26: Zero or negative limit → 400 ────────────────────────
  it('rejects limit=0 with validation error', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs?limit=0', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(400);
  });

  // ── Test 27: Offset beyond total → 200 with empty data ───────────
  it('returns empty data for offset beyond total', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs?offset=999999', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  // ── Test 28: Security headers present ─────────────────────────────
  it('includes security headers on every response', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  // ── Test 29: X-Request-Id header present ──────────────────────────
  it('includes X-Request-Id with UUID-like value', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeDefined();
    // UUID format: 8-4-4-4-12 hex chars
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
