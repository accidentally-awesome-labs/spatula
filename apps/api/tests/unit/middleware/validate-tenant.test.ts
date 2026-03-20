import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { validateTenantMiddleware } from '../../../src/middleware/validate-tenant.js';

describe('validateTenantMiddleware', () => {
  it('passes when tenantRepo is not configured', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', {});
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('passes when tenant exists', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', { tenantRepo: { findById: vi.fn().mockResolvedValue({ id: 'tenant-1' }) } });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 404 when tenant does not exist', async () => {
    const app = new Hono();
    app.onError((err, c) => {
      return c.json({ error: { message: err.message } }, 404);
    });
    app.use('*', async (c, next) => {
      c.set('tenantId', 'nonexistent');
      c.set('deps', { tenantRepo: { findById: vi.fn().mockResolvedValue(null) } });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(404);
  });
});
