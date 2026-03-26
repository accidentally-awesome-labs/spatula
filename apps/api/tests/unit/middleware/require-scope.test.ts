import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireScope } from '../../../src/middleware/require-scope.js';
import { ForbiddenError } from '@spatula/shared';

function createTestApp(requiredScope: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', c.req.header('x-test-scopes')
      ? { tenantId: 't', userId: 'u', scopes: JSON.parse(c.req.header('x-test-scopes')!) }
      : undefined);
    return next();
  });
  app.use('*', requireScope(requiredScope));
  app.get('/test', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof ForbiddenError) {
      return c.json({ error: { code: 'FORBIDDEN', message: err.message } }, 403);
    }
    return c.json({ error: { code: 'INTERNAL', message: err.message } }, 500);
  });
  return app;
}

describe('requireScope', () => {
  it('allows request when scope matches', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["jobs:read", "jobs:write"]' },
    });
    expect(res.status).toBe(200);
  });

  it('allows request when user has admin scope', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["admin"]' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects request when scope is missing', async () => {
    const app = createTestApp('jobs:write');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["jobs:read"]' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects request when auth context is not set', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test');
    expect(res.status).toBe(403);
  });
});
