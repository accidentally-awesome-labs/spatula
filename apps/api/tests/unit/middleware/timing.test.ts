import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { timingMiddleware } from '../../../src/middleware/timing.js';

describe('timingMiddleware', () => {
  it('records request duration and increments request counter', async () => {
    const mockMetrics = {
      httpRequestDuration: { record: vi.fn() },
      httpRequestsTotal: { add: vi.fn() },
      httpActiveConnections: { add: vi.fn() },
    };
    const app = new Hono();
    app.use('*', timingMiddleware(mockMetrics as any));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(mockMetrics.httpRequestsTotal.add).toHaveBeenCalledWith(1, expect.objectContaining({ method: 'GET', status: 200 }));
    expect(mockMetrics.httpRequestDuration.record).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ method: 'GET', status: 200 }));
  });

  it('tracks active connections (increment then decrement)', async () => {
    const mockMetrics = {
      httpRequestDuration: { record: vi.fn() },
      httpRequestsTotal: { add: vi.fn() },
      httpActiveConnections: { add: vi.fn() },
    };
    const app = new Hono();
    app.use('*', timingMiddleware(mockMetrics as any));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');
    const calls = mockMetrics.httpActiveConnections.add.mock.calls;
    expect(calls).toContainEqual([1]);
    expect(calls).toContainEqual([-1]);
  });

  it('passes through when metrics is null', async () => {
    const app = new Hono();
    app.use('*', timingMiddleware(null));
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});
