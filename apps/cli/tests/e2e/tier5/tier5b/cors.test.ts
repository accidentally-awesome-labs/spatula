import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupAuthContext, bearerHeaders, type AuthTestContext } from './helpers.js';

describe('Tier 5B: CORS', () => {
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

  // ── Test 12: Preflight from allowed origin → correct headers ──────
  it('returns CORS headers for allowed origin preflight', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });
    // Hono cors returns 204 for preflight
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  // ── Test 13: Preflight from disallowed origin → no ACAO header ────
  it('does not return ACAO for disallowed origin', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // ── Test 14: Response exposes rate limit and request-id headers ────
  it('exposes rate limit and request-id headers via CORS', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: {
        ...bearerHeaders(ctx.adminKey),
        Origin: 'http://localhost:3000',
      },
    });
    expect(res.status).toBe(200);
    const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('X-RateLimit-Limit');
    expect(exposed).toContain('X-Request-Id');
  });
});
