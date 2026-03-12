import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { tenantMiddleware } from '../../../src/middleware/tenant.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

describe('tenantMiddleware', () => {
  it('extracts tenant ID from x-tenant-id header', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ tenantId: c.get('tenantId') }));

    const res = await app.request('/test', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when x-tenant-id is not a valid UUID', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', tenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-tenant-id': 'not-a-uuid' },
    });
    expect(res.status).toBe(400);
  });

  it('skips tenant check for /health endpoint', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', tenantMiddleware);
    app.get('/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
