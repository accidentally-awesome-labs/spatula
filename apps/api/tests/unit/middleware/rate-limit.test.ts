import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rateLimitMiddleware } from '../../../src/middleware/rate-limit.js';
import { _resetRateLimitsCacheForTests } from '../../../src/middleware/rate-limit-config.js';
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
  let tmpDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.SPATULA_RATE_LIMITS_PATH;
    tmpDir = mkdtempSync(join(tmpdir(), 'spatula-rl-mw-'));

    // Default test fixture: matches DEFAULT_RATE_LIMIT (300 rpm) so existing
    // assertions stay valid. Each test that needs a different config overrides
    // SPATULA_RATE_LIMITS_PATH inside the test body before calling createTestApp.
    const fixturePath = join(tmpDir, 'rl.yaml');
    writeFileSync(
      fixturePath,
      `default:
  requestsPerMinute: 300
  maxConcurrentJobs: 10
`,
      'utf-8',
    );
    process.env.SPATULA_RATE_LIMITS_PATH = fixturePath;
    _resetRateLimitsCacheForTests();

    redis = createMockRedis();
  });

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.SPATULA_RATE_LIMITS_PATH;
    } else {
      process.env.SPATULA_RATE_LIMITS_PATH = envBackup;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    _resetRateLimitsCacheForTests();
  });

  describe('header emission (API-02)', () => {
    it('emits ALL FOUR headers on success: Limit, Remaining, Reset', async () => {
      (redis as any).eval.mockResolvedValue([1, 5]);
      const app = createTestApp(redis);
      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('295');
      const resetHeader = res.headers.get('X-RateLimit-Reset');
      expect(resetHeader).not.toBeNull();
      const resetEpoch = Number(resetHeader);
      // Reset must be in the future and within ~70 seconds of now.
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(resetEpoch).toBeGreaterThanOrEqual(nowEpoch);
      expect(resetEpoch).toBeLessThanOrEqual(nowEpoch + 70);
    });

    it('on 429: emits Retry-After plus the new RATE_LIMIT.EXCEEDED envelope with limit + resetAt details', async () => {
      (redis as any).eval.mockResolvedValue([0, 300]);
      const app = createTestApp(redis);
      const res = await app.request('/test');
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');
      // The X-RateLimit-Reset header is ALSO present on 429 (set before verdict).
      expect(res.headers.get('X-RateLimit-Reset')).not.toBeNull();
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMIT.EXCEEDED');
      expect(body.error.details).toBeDefined();
      expect(body.error.details.limit).toBe(300);
      expect(body.error.details.resetAt).toEqual(expect.any(Number));
    });
  });

  describe('per-route lookup (API-03)', () => {
    it('uses per-route config when route key matches', async () => {
      const fixturePath = join(tmpDir, 'rl.yaml');
      writeFileSync(
        fixturePath,
        `default:
  requestsPerMinute: 300

routeGroups:
  "GET /test":
    requestsPerMinute: 50
`,
        'utf-8',
      );
      process.env.SPATULA_RATE_LIMITS_PATH = fixturePath;
      _resetRateLimitsCacheForTests();

      (redis as any).eval.mockResolvedValue([1, 5]);
      const app = createTestApp(redis);
      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('50');
      // Redis script was called with the per-route limit (50), not the default (300)
      expect((redis as any).eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '50',
        expect.any(String),
      );
    });

    it('falls back to default when route key does not match', async () => {
      // Default-only fixture (no /test override)
      (redis as any).eval.mockResolvedValue([1, 5]);
      const app = createTestApp(redis);
      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    });
  });

  describe('skip + error behavior', () => {
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
});
