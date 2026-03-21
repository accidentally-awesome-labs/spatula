import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestContextMiddleware } from '../../../src/middleware/request-context.js';

describe('requestContextMiddleware', () => {
  it('generates requestId and sets response header', async () => {
    const app = new Hono();
    app.use('*', requestContextMiddleware);
    app.get('/test', (c) => c.json({ requestId: c.get('requestId') }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBeDefined();
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('uses x-request-id header when provided', async () => {
    const app = new Hono();
    app.use('*', requestContextMiddleware);
    app.get('/test', (c) => c.json({ requestId: c.get('requestId') }));

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'custom-id-123' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('custom-id-123');
  });
});
