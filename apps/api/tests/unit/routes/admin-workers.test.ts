import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminWorkerRoutes } from '../../../src/routes/admin-workers.js';

function createTestApp(mockRedis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'admin');
    c.set('auth', { tenantId: 'admin', userId: 'admin', scopes: ['admin'] });
    c.set('deps', { redis: mockRedis });
    return next();
  });
  app.route('/api/v1/admin/workers', adminWorkerRoutes());
  return app;
}

describe('Admin worker routes', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = { scan: vi.fn(), get: vi.fn(), mget: vi.fn() };
  });

  it('returns list of healthy workers', async () => {
    mockRedis.scan.mockResolvedValueOnce(['0', ['worker:heartbeat:host1-1234']]);
    mockRedis.mget.mockResolvedValue([JSON.stringify({
      workerId: 'host1-1234', queues: ['spatula.crawl'], pid: 1234,
      uptime: 3600, activeJobs: 2, lastBeat: new Date().toISOString(),
    })]);
    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].workerId).toBe('host1-1234');
    expect(body.data[0].status).toBe('healthy');
  });

  it('returns empty list when no workers', async () => {
    mockRedis.scan.mockResolvedValue(['0', []]);
    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('returns 500 when Redis unavailable', async () => {
    const app = createTestApp(null);
    app.onError((err, c) => c.json({ error: { message: err.message } }, 500));
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(500);
  });
});
