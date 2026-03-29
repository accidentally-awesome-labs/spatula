import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { idempotencyMiddleware } from '../../../src/middleware/idempotency.js';

function createMockRedis() {
  return { get: vi.fn(), set: vi.fn() };
}

function createTestApp(redis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('deps', { redis });
    return next();
  });
  app.use('*', idempotencyMiddleware());
  app.post('/test', (c) => c.json({ created: true }, 201));
  app.get('/test', (c) => c.json({ data: 'ok' }));
  return app;
}

describe('idempotencyMiddleware', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => { redis = createMockRedis(); });

  it('passes through GET requests without checking Redis', async () => {
    const app = createTestApp(redis);
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('passes through POST without Idempotency-Key header', async () => {
    const app = createTestApp(redis);
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns cached response for duplicate Idempotency-Key', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ statusCode: 201, body: { created: true } }));
    const app = createTestApp(redis);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-1' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('caches 2xx response on first POST with Idempotency-Key', async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const app = createTestApp(redis);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-2' },
    });
    expect(res.status).toBe(201);
    expect(redis.set).toHaveBeenCalledWith(
      'idempotency:tenant-1:unique-key-2',
      expect.any(String),
      'EX',
      86400,
    );
  });

  it('does NOT cache error responses', async () => {
    redis.get.mockResolvedValue(null);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', { redis });
      return next();
    });
    app.use('*', idempotencyMiddleware());
    app.post('/test', (c) => c.json({ error: 'bad request' }, 400));
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'error-key' },
    });
    expect(res.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('works without Redis (passes through)', async () => {
    const app = createTestApp(null);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
    });
    expect(res.status).toBe(201);
  });
});
