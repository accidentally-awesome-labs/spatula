import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/middleware/auth.js';
import type { AuthProvider, AuditLogger, AuthResult } from '@spatula/shared';
import type { UserTenantRepository, TenantRepository } from '@spatula/db';
import type { UserTenantEntry } from '@spatula/db';

function createJwtProvider(overrides: Partial<AuthResult> = {}): AuthProvider {
  return {
    authenticate: vi.fn().mockResolvedValue({
      tenantId: '',
      userId: 'auth0|user1',
      scopes: ['jobs:read', 'jobs:write'],
      strategy: 'jwt' as const,
      ...overrides,
    }),
  };
}

function createMockUserTenantRepo(entries: UserTenantEntry[] = []): UserTenantRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue(entries),
    create: vi.fn().mockResolvedValue(undefined),
    findByTenantId: vi.fn().mockResolvedValue([]),
    updateRole: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    isAdmin: vi.fn().mockResolvedValue(false),
  } as unknown as UserTenantRepository;
}

function createMockTenantRepo(autoTenantId = 'auto-tenant-id'): TenantRepository {
  return {
    create: vi.fn().mockResolvedValue({ id: autoTenantId, name: 'test' }),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    getQuotas: vi.fn().mockResolvedValue({}),
    incrementStorageBytes: vi.fn().mockResolvedValue(undefined),
    setCache: vi.fn(),
  } as unknown as TenantRepository;
}

function createTestApp(
  provider: AuthProvider,
  auditLogger?: AuditLogger,
  userTenantRepo?: UserTenantRepository,
  tenantRepo?: TenantRepository,
) {
  const app = new Hono();
  app.use('*', authMiddleware(provider, auditLogger, userTenantRepo, tenantRepo));
  app.get('/api/v1/test', (c) => {
    return c.json({
      tenantId: c.get('tenantId'),
      auth: c.get('auth'),
    });
  });
  return app;
}

describe('JWT tenant resolution', () => {
  it('auto-selects tenant when JWT user has exactly 1 tenant', async () => {
    const provider = createJwtProvider();
    const userTenantRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-abc', role: 'owner', createdAt: new Date() },
    ]);
    const tenantRepo = createMockTenantRepo();
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer jwt-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-abc');
    expect(body.auth.tenantId).toBe('tenant-abc');
    expect(body.auth.strategy).toBe('jwt');
    expect(userTenantRepo.findByUserId).toHaveBeenCalledWith('auth0|user1');
  });

  it('selects correct tenant via X-Tenant-Id when JWT user has multiple tenants', async () => {
    const provider = createJwtProvider();
    const userTenantRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-1', role: 'owner', createdAt: new Date() },
      { tenantId: 'tenant-2', role: 'member', createdAt: new Date() },
    ]);
    const tenantRepo = createMockTenantRepo();
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: {
        authorization: 'Bearer jwt-token',
        'x-tenant-id': 'tenant-2',
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-2');
    expect(body.auth.tenantId).toBe('tenant-2');
  });

  it('returns 400 TENANT_REQUIRED when JWT user has multiple tenants and no X-Tenant-Id', async () => {
    const provider = createJwtProvider();
    const userTenantRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-1', role: 'owner', createdAt: new Date() },
      { tenantId: 'tenant-2', role: 'member', createdAt: new Date() },
    ]);
    const tenantRepo = createMockTenantRepo();
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer jwt-token' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT_REQUIRED');
    expect(body.error.tenants).toHaveLength(2);
    expect(body.error.tenants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: 'tenant-1', role: 'owner' }),
        expect.objectContaining({ tenantId: 'tenant-2', role: 'member' }),
      ]),
    );
  });

  it('returns 403 when JWT user specifies tenant they do not belong to', async () => {
    const provider = createJwtProvider();
    const userTenantRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-1', role: 'owner', createdAt: new Date() },
      { tenantId: 'tenant-2', role: 'member', createdAt: new Date() },
    ]);
    const tenantRepo = createMockTenantRepo();
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: {
        authorization: 'Bearer jwt-token',
        'x-tenant-id': 'tenant-not-mine',
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT_FORBIDDEN');
  });

  it('auto-creates tenant when JWT user has 0 tenants', async () => {
    const provider = createJwtProvider();
    const userTenantRepo = createMockUserTenantRepo([]); // 0 tenants
    const tenantRepo = createMockTenantRepo('new-auto-tenant');
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer jwt-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('new-auto-tenant');
    expect(body.auth.tenantId).toBe('new-auto-tenant');
    expect(tenantRepo.create).toHaveBeenCalledWith({ name: 'auth0|user1' });
    expect(userTenantRepo.create).toHaveBeenCalledWith('auth0|user1', 'new-auto-tenant', 'owner');
  });

  it('passes through tenantId unchanged for api-key strategy', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockResolvedValue({
        tenantId: 'api-key-tenant',
        userId: 'key-user',
        scopes: ['jobs:read'],
        strategy: 'api-key' as const,
      }),
    };
    const userTenantRepo = createMockUserTenantRepo([]);
    const tenantRepo = createMockTenantRepo();
    const app = createTestApp(provider, undefined, userTenantRepo, tenantRepo);

    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer api-key' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('api-key-tenant');
    expect(body.auth.tenantId).toBe('api-key-tenant');
    // userTenantRepo should NOT be called for api-key strategy
    expect(userTenantRepo.findByUserId).not.toHaveBeenCalled();
  });

  describe('audit logging for JWT resolution', () => {
    it('logs resolved tenantId (not empty) after JWT tenant resolution', async () => {
      const provider = createJwtProvider();
      const userTenantRepo = createMockUserTenantRepo([
        { tenantId: 'resolved-tenant', role: 'owner', createdAt: new Date() },
      ]);
      const tenantRepo = createMockTenantRepo();
      const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
      const app = createTestApp(provider, auditLogger, userTenantRepo, tenantRepo);

      await app.request('/api/v1/test', {
        headers: { authorization: 'Bearer jwt-token' },
      });

      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'resolved-tenant',
          actorId: 'auth0|user1',
          actorType: 'user',
          action: 'auth.login_success',
        }),
      );
    });

    it('does not double-log for JWT strategy (only logs after resolution)', async () => {
      const provider = createJwtProvider();
      const userTenantRepo = createMockUserTenantRepo([
        { tenantId: 'tenant-1', role: 'owner', createdAt: new Date() },
      ]);
      const tenantRepo = createMockTenantRepo();
      const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
      const app = createTestApp(provider, auditLogger, userTenantRepo, tenantRepo);

      await app.request('/api/v1/test', {
        headers: { authorization: 'Bearer jwt-token' },
      });

      // Should only be called once (after resolution), not twice
      expect(auditLogger.log).toHaveBeenCalledTimes(1);
    });
  });
});
