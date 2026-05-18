import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from '../../../src/middleware/rate-limit.js';
import type Redis from 'ioredis';

function createMockRedis() {
  return { eval: vi.fn() } as unknown as Redis;
}

function createTestApp(redis: Redis) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'u', scopes: ['admin'] });
    return next();
  });
  app.use('*', rateLimitMiddleware(redis));
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('rateLimitMiddleware', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('allows request when under limit', async () => {
    (redis as any).eval.mockResolvedValue([1, 5]);
    const app = createTestApp(redis);
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    // DEFAULT_RATE_LIMIT.requestsPerMinute === 300
    expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('295');
  });

  it('rejects request when over limit with 429 and Retry-After header', async () => {
    (redis as any).eval.mockResolvedValue([0, 300]);
    const app = createTestApp(redis);
    const res = await app.request('/test');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT_ERROR');
  });

  it('skips rate limiting when tenantId is not set', async () => {
    const app = new Hono();
    // No tenantId set in context
    app.use('*', rateLimitMiddleware(redis));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect((redis as any).eval).not.toHaveBeenCalled();
  });

  it('propagates Redis eval failure as unhandled error', async () => {
    (redis as any).eval.mockRejectedValue(new Error('REDIS CONN REFUSED'));
    const app = createTestApp(redis);

    const res = await app.request('/test');
    // When Redis.eval throws, the middleware does NOT catch it — it bubbles up.
    // Without an error handler, Hono returns 500.
    expect(res.status).toBe(500);
  });
});
