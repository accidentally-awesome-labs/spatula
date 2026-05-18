import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { timeoutMiddleware } from '../../../src/middleware/timeout.js';

describe('timeoutMiddleware', () => {
  it('allows requests that complete within timeout', async () => {
    const app = new Hono();
    app.use('*', timeoutMiddleware({ defaultMs: 1000 }));
    app.get('/fast', (c) => c.json({ ok: true }));

    const res = await app.request('/fast');
    expect(res.status).toBe(200);
  });

  it('returns 504 when request exceeds timeout', async () => {
    const app = new Hono();
    app.use('*', timeoutMiddleware({ defaultMs: 50 }));
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 200));
      return c.json({ ok: true });
    });

    const res = await app.request('/slow');
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe('TIMEOUT');
  });

  it('uses route-specific timeout when configured', async () => {
    const app = new Hono();
    app.use(
      '*',
      timeoutMiddleware({
        defaultMs: 50,
        overrides: { '/api/v1/exports/:exportId/download': 5000 },
      }),
    );
    app.get('/api/v1/exports/:exportId/download', async (c) => {
      await new Promise((r) => setTimeout(r, 100));
      return c.json({ ok: true });
    });

    const res = await app.request('/api/v1/exports/exp-1/download');
    expect(res.status).toBe(200);
  });

  it('does not timeout on normal route with override configured', async () => {
    const app = new Hono();
    app.use(
      '*',
      timeoutMiddleware({
        defaultMs: 5000,
        overrides: { '/api/v1/exports/:exportId/download': 300000 },
      }),
    );
    app.get('/api/v1/fast', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/fast');
    expect(res.status).toBe(200);
  });
});
