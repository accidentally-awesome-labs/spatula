import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../../../src/routes/auth.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { AppEnv } from '../../../src/types.js';

function createTestApp(opts: { tenantId?: string; scopes?: string[]; authUserId?: string | null }) {
  const app = new Hono<AppEnv>();
  // /me throws AuthMissingTokenError when tenantId is unset;
  // wire the real errorHandler so the test sees the envelope shape.
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (opts.tenantId !== undefined) c.set('tenantId', opts.tenantId);
    if (opts.scopes !== undefined) {
      // Mirror real middleware: 'auth' carries the AuthResult including scopes
      c.set('auth', {
        tenantId: opts.tenantId ?? '',
        userId: opts.authUserId ?? '',
        scopes: opts.scopes,
        strategy: 'none',
      });
    }
    return next();
  });
  app.route('/api/v1/auth', authRoutes());
  return app;
}

describe('GET /api/v1/auth/me', () => {
  it('returns 200 with tenantId + scopes + subject + authenticated when context is present', async () => {
    const app = createTestApp({
      tenantId: 'tenant-abc',
      scopes: ['jobs:read', 'exports:read'],
      authUserId: 'user-xyz',
    });

    const res = await app.request('/api/v1/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      tenantId: 'tenant-abc',
      scopes: ['jobs:read', 'exports:read'],
      subject: 'user-xyz',
      authenticated: true,
    });
  });

  it('returns 401 UNAUTHENTICATED when no tenantId is set on context', async () => {
    const app = createTestApp({});

    const res = await app.request('/api/v1/auth/me');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH.MISSING_TOKEN');
    expect(body.error.message).toBe('No tenant context');
  });

  it('returns scopes as an array (even when empty)', async () => {
    const app = createTestApp({
      tenantId: 'tenant-abc',
      scopes: [],
      authUserId: null,
    });

    const res = await app.request('/api/v1/auth/me');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes).toEqual([]);
    expect(body.subject).toBeNull();
  });
});
