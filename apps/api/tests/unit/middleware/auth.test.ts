import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/middleware/auth.js';
import type { AuthProvider } from '@spatula/shared';

function createTestApp(provider: AuthProvider) {
  const app = new Hono();
  app.use('*', authMiddleware(provider));
  app.get('/api/v1/test', (c) => {
    return c.json({
      tenantId: c.get('tenantId'),
      auth: c.get('auth'),
    });
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/health/ready', (c) => c.json({ status: 'ok' }));
  app.get('/api/docs', (c) => c.text('docs'));
  app.get('/api/openapi.json', (c) => c.json({}));
  return app;
}

describe('authMiddleware', () => {
  it('sets tenantId and auth on context for authenticated requests', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        userId: 'user-1',
        scopes: ['jobs:read'],
      }),
    };
    const app = createTestApp(provider);
    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-1');
    expect(body.auth.userId).toBe('user-1');
    expect(body.auth.scopes).toEqual(['jobs:read']);
  });

  it('skips auth for /health', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /health/live', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);
    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /api/docs', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);
    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /api/openapi.json', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /api/v1/tenants prefix', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);
    app.get('/api/v1/tenants', (c) => c.json({ tenants: [] }));
    const res = await app.request('/api/v1/tenants');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('propagates AuthError from provider as-is', async () => {
    const { AuthError } = await import('@spatula/shared');
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new AuthError('bad token')),
    };
    const app = createTestApp(provider);
    app.onError((err, c) => {
      if (err instanceof AuthError) {
        return c.json({ error: { code: 'AUTH_ERROR', message: err.message } }, 401);
      }
      return c.json({ error: { code: 'INTERNAL', message: 'unknown' } }, 500);
    });
    const res = await app.request('/api/v1/test');
    expect(res.status).toBe(401);
  });
});
