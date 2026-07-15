import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { SpatulaError } from '@accidentally-awesome-labs/spatula-shared';
import { validateTenantMiddleware } from '../../../src/middleware/validate-tenant.js';

describe('validateTenantMiddleware', () => {
  function createApp(tenantRepo: any) {
    const app = new Hono();
    // Map SpatulaError codes to HTTP statuses (mirrors real error handler)
    app.onError((err, c) => {
      if (err instanceof SpatulaError) {
        // SpatulaError.code uses `DOMAIN.CODE` form.
        // (e.g., TENANT.NOT_FOUND, AUTH.INSUFFICIENT_SCOPE). Mirrors STATUS_MAP.
        const statusMap: Record<string, number> = {
          'TENANT.NOT_FOUND': 404,
          'AUTH.INSUFFICIENT_SCOPE': 403,
          // legacy fallthrough for any caller still on flat codes
          NOT_FOUND: 404,
          FORBIDDEN: 403,
        };
        const status = statusMap[err.code] ?? 500;
        return c.json({ error: { code: err.code, message: err.message } }, status as any);
      }
      return c.json({ error: { message: err.message } }, 500);
    });
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-1');
      c.set('deps', { tenantRepo });
      return next();
    });
    app.use('*', validateTenantMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('returns 403 for suspended tenant', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        config: { status: 'suspended' },
      }),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('suspended');
  });

  it('allows active tenant through', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        config: {},
      }),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('allows tenant with explicit active status through', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        config: { status: 'active' },
      }),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown tenant', async () => {
    const app = createApp({
      findById: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request('/test');
    expect(res.status).toBe(404);
  });

  it('passes through when tenantRepo is undefined', async () => {
    const app = createApp(undefined);
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});
