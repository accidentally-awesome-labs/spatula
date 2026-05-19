import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {} as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      create: vi.fn().mockResolvedValue({
        id: 'new-tenant-id',
        name: 'Test Corp',
        config: {},
        createdAt: new Date(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Existing Corp',
        config: { maxJobs: 10 },
        createdAt: new Date(),
      }),
      update: vi.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Updated Corp',
        config: { maxJobs: 20 },
        createdAt: new Date(),
      }),
    } as any,
  };
}

describe('tenant creation auth protection', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 403 when secret is set and header is missing', async () => {
    vi.stubEnv('TENANT_CREATION_SECRET', 'super-secret');
    const app = createApp(deps);
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Corp' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH.INSUFFICIENT_SCOPE');
  });

  it('returns 403 when secret is set and header is wrong', async () => {
    vi.stubEnv('TENANT_CREATION_SECRET', 'super-secret');
    const app = createApp(deps);
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Creation-Secret': 'wrong-secret',
      },
      body: JSON.stringify({ name: 'Test Corp' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH.INSUFFICIENT_SCOPE');
  });

  it('allows creation when secret matches', async () => {
    vi.stubEnv('TENANT_CREATION_SECRET', 'super-secret');
    const app = createApp(deps);
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Creation-Secret': 'super-secret',
      },
      body: JSON.stringify({ name: 'Test Corp' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe('Test Corp');
  });

  it('allows creation when TENANT_CREATION_SECRET is not set', async () => {
    vi.stubEnv('TENANT_CREATION_SECRET', '');
    const app = createApp(deps);
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Corp' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe('Test Corp');
  });

  it('allows GET requests without secret when secret is set', async () => {
    vi.stubEnv('TENANT_CREATION_SECRET', 'super-secret');
    const app = createApp(deps);
    const res = await app.request('/api/v1/tenants/tenant-1');

    expect(res.status).toBe(200);
  });
});

describe('Tenant routes', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('POST /api/v1/tenants', () => {
    it('creates a tenant without requiring x-tenant-id', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Corp' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe('Test Corp');
    });

    it('rejects empty name', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/tenants/:id', () => {
    it('returns tenant by ID without requiring x-tenant-id', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Existing Corp');
    });

    it('returns 404 for nonexistent tenant', async () => {
      deps.tenantRepo!.findById = vi.fn().mockResolvedValue(null) as any;
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/tenants/:id', () => {
    it('updates tenant name and config', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Corp', config: { maxJobs: 20 } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Corp');
    });

    it('accepts partial update with only name', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(200);
    });

    it('accepts partial update with only config', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { key: 'val' } }),
      });

      expect(res.status).toBe(200);
    });

    it('rejects empty body with no fields', async () => {
      const app = createApp(deps);
      const res = await app.request('/api/v1/tenants/tenant-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
