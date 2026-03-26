import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { wsTokenRoutes } from '../../../src/routes/ws-token.js';

function createTestApp(mockRedis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', { redis: mockRedis });
    return next();
  });
  app.route('/api/v1/ws-token', wsTokenRoutes());
  return app;
}

describe('WS Token routes', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = { set: vi.fn().mockResolvedValue('OK') };
  });

  it('creates a WS token stored in Redis with 60s TTL', async () => {
    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/ws-token', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.token).toBeDefined();
    expect(body.data.expiresIn).toBe(60);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^ws-token:/),
      expect.stringContaining('tenant-1'),
      'EX',
      60,
    );
  });
});
