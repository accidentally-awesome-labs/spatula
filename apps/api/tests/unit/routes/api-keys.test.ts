import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from '../../../src/routes/api-keys.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['keys:manage', 'jobs:read', 'jobs:write', 'exports:read', 'exports:write', 'actions:read', 'actions:write'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/api-keys', apiKeyRoutes());
  return app;
}

describe('API Key routes', () => {
  let mockApiKeyRepo: any;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    mockApiKeyRepo = {
      create: vi.fn().mockResolvedValue({
        id: 'key-1',
        tenantId: 'tenant-1',
        keyHash: 'hash',
        keyPrefix: 'sk_live_abcd',
        name: 'Test Key',
        scopes: ['jobs:read', 'jobs:write'],
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        revokedAt: null,
      }),
      listByTenant: vi.fn().mockResolvedValue([
        {
          id: 'key-1',
          keyPrefix: 'sk_live_abcd',
          name: 'Test Key',
          scopes: ['jobs:read'],
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
        },
      ]),
      revoke: vi.fn().mockResolvedValue({
        id: 'key-1',
        revokedAt: new Date(),
      }),
    };
    app = createTestApp({ apiKeyRepo: mockApiKeyRepo });
  });

  describe('POST /api/v1/api-keys', () => {
    it('creates an API key and returns raw key once', async () => {
      const res = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Key' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.key).toBeDefined();
      expect(body.data.key).toMatch(/^sk_live_/);
      expect(body.data.name).toBe('Test Key');
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          name: 'Test Key',
          keyHash: expect.any(String),
          keyPrefix: expect.stringMatching(/^sk_live_.{4}/),
        }),
      );
    });
  });

  describe('GET /api/v1/api-keys', () => {
    it('lists API keys for tenant (without hashes)', async () => {
      const res = await app.request('/api/v1/api-keys');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].keyPrefix).toBe('sk_live_abcd');
      expect(body.data[0]).not.toHaveProperty('keyHash');
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    it('revokes an API key (soft delete)', async () => {
      const res = await app.request('/api/v1/api-keys/key-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(mockApiKeyRepo.revoke).toHaveBeenCalledWith('key-1', 'tenant-1');
    });
  });
});
