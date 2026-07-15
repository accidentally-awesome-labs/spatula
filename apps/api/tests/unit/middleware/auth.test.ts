import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/middleware/auth.js';
import type { AuthProvider, AuditLogger } from '@accidentally-awesome-labs/spatula-shared';

function createTestApp(provider: AuthProvider, auditLogger?: AuditLogger) {
  const app = new Hono();
  app.use('*', authMiddleware(provider, auditLogger));
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

// Auth middleware boots a Hono app + Pino logger per test; that first-load
// can exceed vitest's 5s default on cold CI runners. Bumped to 30s.
describe('authMiddleware', { timeout: 30_000 }, () => {
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
    const { AuthError } = await import('@accidentally-awesome-labs/spatula-shared');
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

  describe('audit logging', () => {
    it('calls auditLogger.log with auth.login_success on successful auth', async () => {
      const provider: AuthProvider = {
        authenticate: vi.fn().mockResolvedValue({
          tenantId: 'tenant-1',
          userId: 'user-1',
          scopes: ['jobs:read'],
        }),
      };
      const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
      const app = createTestApp(provider, auditLogger);

      await app.request('/api/v1/test', {
        headers: { authorization: 'Bearer test-token' },
      });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          actorId: 'user-1',
          action: 'auth.login_success',
        }),
      );
    });

    it('calls auditLogger.log with auth.login_failure on auth error', async () => {
      const { AuthError } = await import('@accidentally-awesome-labs/spatula-shared');
      const provider: AuthProvider = {
        authenticate: vi.fn().mockRejectedValue(new AuthError('invalid key')),
      };
      const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
      const app = createTestApp(provider, auditLogger);
      app.onError((err, c) => c.json({ error: 'fail' }, 401));

      await app.request('/api/v1/test');

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'unknown',
          action: 'auth.login_failure',
          metadata: expect.objectContaining({
            error: 'invalid key',
          }),
        }),
      );
    });

    it('extracts IP address from x-forwarded-for header (first IP only)', async () => {
      const provider: AuthProvider = {
        authenticate: vi.fn().mockResolvedValue({
          tenantId: 'tenant-1',
          userId: 'user-1',
          scopes: ['jobs:read'],
        }),
      };
      const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
      const app = createTestApp(provider, auditLogger);

      await app.request('/api/v1/test', {
        headers: {
          authorization: 'Bearer test-token',
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
        },
      });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '192.168.1.1',
        }),
      );
    });
  });
});
