import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from '../../../src/routes/api-keys.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', {
      tenantId: 'tenant-1',
      userId: 'user-1',
      scopes: [
        'keys:manage',
        'jobs:read',
        'jobs:write',
        'exports:read',
        'exports:write',
        'actions:read',
        'actions:write',
      ],
    });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/api-keys', apiKeyRoutes());
  return app;
}

describe('API Key routes', () => {
  let mockApiKeyRepo: any;
  let mockAuditLogger: any;
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
    mockAuditLogger = { log: vi.fn() };
    app = createTestApp({ apiKeyRepo: mockApiKeyRepo, auditLogger: mockAuditLogger });
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

  describe('audit logging', () => {
    it('calls auditLogger.log with api_key.created after POST', async () => {
      await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Audit Test Key' }),
      });

      expect(mockAuditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          actorId: 'user-1',
          action: 'api_key.created',
          resourceType: 'api_key',
          resourceId: 'key-1',
        }),
      );
    });

    it('calls auditLogger.log with api_key.revoked after DELETE', async () => {
      await app.request('/api/v1/api-keys/key-1', {
        method: 'DELETE',
      });

      expect(mockAuditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          actorId: 'user-1',
          action: 'api_key.revoked',
          resourceType: 'api_key',
          resourceId: 'key-1',
        }),
      );
    });
  });

  describe('scopes and expiration params', () => {
    it('POST with custom scopes array creates key with those scopes', async () => {
      const customScopes = ['jobs:read', 'exports:read'];
      mockApiKeyRepo.create.mockResolvedValue({
        id: 'key-2',
        tenantId: 'tenant-1',
        keyHash: 'hash2',
        keyPrefix: 'sk_live_efgh',
        name: 'Scoped Key',
        scopes: customScopes,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        revokedAt: null,
      });

      const res = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Scoped Key', scopes: customScopes }),
      });

      expect(res.status).toBe(201);
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: customScopes,
        }),
      );
    });

    it('POST with expiresAt creates key with expiration', async () => {
      const expiresAt = '2027-06-01T00:00:00Z';
      mockApiKeyRepo.create.mockResolvedValue({
        id: 'key-3',
        tenantId: 'tenant-1',
        keyHash: 'hash3',
        keyPrefix: 'sk_live_ijkl',
        name: 'Expiring Key',
        scopes: ['jobs:read', 'jobs:write'],
        expiresAt: new Date(expiresAt),
        lastUsedAt: null,
        createdAt: new Date(),
        revokedAt: null,
      });

      const res = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Expiring Key', expiresAt }),
      });

      expect(res.status).toBe(201);
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: new Date(expiresAt),
        }),
      );
    });

    it('POST without scopes defaults to DEFAULT_API_KEY_SCOPES', async () => {
      const res = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Default Scopes Key' }),
      });

      expect(res.status).toBe(201);
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: expect.arrayContaining([
            'jobs:read',
            'jobs:write',
            'exports:read',
            'exports:write',
            'actions:read',
            'actions:write',
          ]),
        }),
      );
    });
  });
});
