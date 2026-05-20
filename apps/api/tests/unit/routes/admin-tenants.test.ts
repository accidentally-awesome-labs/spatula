import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const SAMPLE_TENANT = {
  id: TENANT_ID,
  name: 'Acme Corp',
  storageBytesUsed: 1024,
  createdAt: new Date('2026-03-01T00:00:00Z'),
  config: { retention: { completedJobsDays: 30 } },
};

const SAMPLE_TENANT_2 = {
  id: '00000000-0000-0000-0000-000000000002',
  name: 'Beta Inc',
  storageBytesUsed: 512,
  createdAt: new Date('2026-03-10T00:00:00Z'),
  config: {},
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([
        {
          id: 'job-1',
          name: 'My Job',
          status: 'running',
          createdAt: new Date('2026-03-20T00:00:00Z'),
        },
      ]),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue(SAMPLE_TENANT),
      findAll: vi.fn().mockResolvedValue([SAMPLE_TENANT, SAMPLE_TENANT_2]),
      countAll: vi.fn().mockResolvedValue(2),
      update: vi.fn().mockResolvedValue(SAMPLE_TENANT),
    } as any,
    userTenantRepo: {
      findByTenantId: vi.fn().mockResolvedValue([
        { userId: 'user-1', role: 'owner' },
        { userId: 'user-2', role: 'member' },
      ]),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/tenants', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns paginated list with userCount', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/tenants', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe(TENANT_ID);
    expect(body.data[0].name).toBe('Acme Corp');
    expect(body.data[0].userCount).toBe(2);
    expect(body.data[0].config).toEqual({ retention: { completedJobsDays: 30 } });
    expect(body.pagination).toEqual({ total: 2, limit: 50, offset: 0 });
  });

  it('passes pagination options to repo (plan filter removed post-carveout)', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/tenants?limit=10&offset=5', {
      headers: tenantHeader,
    });

    expect(deps.tenantRepo!.findAll).toHaveBeenCalledWith({ limit: 10, offset: 5 });
    expect(deps.tenantRepo!.countAll).toHaveBeenCalledWith();
  });

  it('clamps limit to max 100', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/tenants?limit=500', { headers: tenantHeader });

    expect(deps.tenantRepo!.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('returns 503 when tenantRepo is not configured', async () => {
    deps = createMockDeps({ tenantRepo: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/tenants', { headers: tenantHeader });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL.QUEUE');
  });
});

describe('GET /api/v1/admin/tenants/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns detail with users and recent jobs (usage aggregation removed post-carveout)', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TENANT_ID);
    expect(body.data.name).toBe('Acme Corp');
    expect(body.data.users).toEqual([
      { userId: 'user-1', role: 'owner' },
      { userId: 'user-2', role: 'member' },
    ]);
    // usage aggregation removed in carveout — no longer in response
    expect(body.data).not.toHaveProperty('usage');
    expect(body.data.recentJobs).toHaveLength(1);
    expect(body.data.recentJobs[0].id).toBe('job-1');
  });

  it('returns 404 for unknown tenant', async () => {
    (deps.tenantRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/tenants/unknown-id', { headers: tenantHeader });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT.NOT_FOUND');
  });

  it('returns 503 when tenantRepo is not configured', async () => {
    deps = createMockDeps({ tenantRepo: undefined });
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, { headers: tenantHeader });

    expect(res.status).toBe(503);
  });
});

describe('PATCH /api/v1/admin/tenants/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('updates config with retention and writes audit log', async () => {
    const configPayload = { retention: { completedJobsDays: 14, failedJobsDays: 10 } };
    const updatedTenant = {
      ...SAMPLE_TENANT,
      config: { retention: { completedJobsDays: 14, failedJobsDays: 10 } },
    };
    (deps.tenantRepo as any).findById = vi
      .fn()
      .mockResolvedValueOnce(SAMPLE_TENANT) // validate-tenant middleware
      .mockResolvedValueOnce(SAMPLE_TENANT) // existing check
      .mockResolvedValueOnce(updatedTenant); // return after update

    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: configPayload }),
    });

    expect(res.status).toBe(200);
    expect(deps.tenantRepo!.update).toHaveBeenCalledWith(TENANT_ID, {
      config: expect.objectContaining({
        retention: { completedJobsDays: 14, failedJobsDays: 10 },
      }),
    });
    expect(deps.auditLogger!.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.tenant.config_update',
        metadata: { changes: configPayload },
      }),
    );
  });

  it('enforces minimum retention days with 400', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { retention: { completedJobsDays: 3 } } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('completedJobsDays');
    expect(body.error.message).toContain('>= 7');
  });

  it('returns 404 for unknown tenant', async () => {
    (deps.tenantRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { retention: { completedJobsDays: 30 } } }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT.NOT_FOUND');
  });

  it('returns 503 when tenantRepo is not configured', async () => {
    deps = createMockDeps({ tenantRepo: undefined });
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'PATCH',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ config: {} }),
    });

    expect(res.status).toBe(503);
  });
});

describe('DELETE /api/v1/admin/tenants/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    const tenantDeleteQueueAdd = vi.fn().mockResolvedValue({ id: 'job-del-1' });
    deps = createMockDeps({
      queues: {
        tenantDelete: { add: tenantDeleteQueueAdd },
      } as any,
    });
  });

  it('returns 202 with data.jobId when tenant exists', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'DELETE',
      headers: tenantHeader,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe('pending');
    expect(body.data.jobId).toBe('job-del-1');
  });

  it('enqueues a tenantDelete job with the correct tenantId', async () => {
    const app = createApp(deps);
    await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'DELETE',
      headers: tenantHeader,
    });

    expect((deps.queues as any).tenantDelete.add).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });

  it('returns 404 standard envelope when tenant does not exist', async () => {
    (deps.tenantRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'DELETE',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT.NOT_FOUND');
  });

  it('returns 503 when tenantRepo is not configured', async () => {
    deps = createMockDeps({ tenantRepo: undefined });
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}`, {
      method: 'DELETE',
      headers: tenantHeader,
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/v1/admin/tenants/:id/import', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps({
      tenantDataRepo: {
        importTenantData: vi.fn().mockResolvedValue({ imported: { api_keys: 2 } }),
      } as any,
    });
  });

  it('returns 200 with data.imported on success', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}/import`, {
      method: 'POST',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ api_keys: [{ id: 'k1', keyHash: 'h1', keyPrefix: 'sk-', name: 'k' }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.imported).toBeDefined();
    expect(body.data.imported['api_keys']).toBe(2);
  });

  it('returns 404 when tenant does not exist', async () => {
    (deps.tenantRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request(`/api/v1/admin/tenants/${TENANT_ID}/import`, {
      method: 'POST',
      headers: { ...tenantHeader, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT.NOT_FOUND');
  });
});
