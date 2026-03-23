import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
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
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
  };
}

const headers = { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' };
const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('POST /api/v1/jobs', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('creates a job and returns 201', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Test Job',
        description: 'Scrape products',
        seedUrls: ['https://example.com'],
        crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
        schema: { mode: 'discovery' },
        llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
      }),
    });

    expect(res.status).toBe(201);
    expect(deps.jobManager.createJob).toHaveBeenCalled();
    expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('rejects missing required fields', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Test' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects invalid seedUrls', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Test',
        description: 'Test',
        seedUrls: ['not-a-url'],
        crawl: {},
        schema: { mode: 'discovery' },
        llm: {},
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/jobs', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns jobs list with total count', async () => {
    const mockJobs = [{ id: 'job-1', name: 'Test' }];
    (deps.jobRepo as any).findByTenant = vi.fn().mockResolvedValue(mockJobs);
    (deps.jobRepo as any).countByTenant = vi.fn().mockResolvedValue(1);

    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('passes status filter to repository', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/jobs?status=running', { headers: tenantHeader });

    expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ status: 'running' }),
    );
    expect(deps.jobRepo.countByTenant).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ status: 'running' }),
    );
  });

  it('passes offset and limit to repository', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/jobs?limit=10&offset=20', { headers: tenantHeader });

    expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it('applies default limit of 50 and offset of 0', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/jobs', { headers: tenantHeader });

    expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });
});

describe('GET /api/v1/jobs/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns job details', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('job-1');
  });

  it('returns 404 when job not found', async () => {
    (deps.jobRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/nonexistent', { headers: tenantHeader });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/jobs/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('dispatches start action to jobManager', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ action: 'start' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    const body = await res.json();
    expect(body.data.action).toBe('start');
  });

  it('dispatches all 5 actions correctly', async () => {
    const actions = ['start', 'pause', 'resume', 'cancel', 'reconcile'] as const;
    const methods = ['startJob', 'pauseJob', 'resumeJob', 'cancelJob', 'triggerReconciliation'] as const;

    for (let i = 0; i < actions.length; i++) {
      const freshDeps = createMockDeps();
      const app = createApp(freshDeps);
      const res = await app.request('/api/v1/jobs/job-1', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ action: actions[i] }),
      });

      expect(res.status).toBe(200);
      expect((freshDeps.jobManager as any)[methods[i]]).toHaveBeenCalledWith('job-1', TENANT_ID);
    }
  });

  it('returns 404 when job does not exist', async () => {
    (deps.jobRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ action: 'start' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects invalid action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ action: 'invalid' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects missing action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/jobs/:id/{action} (legacy aliases)', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('POST /:id/start calls startJob', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1/start', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    const body = await res.json();
    expect(body.data.message).toBe('Job started');
  });

  it('POST /:id/pause calls pauseJob', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1/pause', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.pauseJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('POST /:id/resume calls resumeJob', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1/resume', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.resumeJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('POST /:id/cancel calls cancelJob', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1/cancel', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.cancelJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('POST /:id/reconcile calls triggerReconciliation', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1/reconcile', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.triggerReconciliation).toHaveBeenCalledWith('job-1', TENANT_ID);
  });
});

describe('DELETE /api/v1/jobs/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns 204 on successful delete', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'DELETE',
      headers: tenantHeader,
    });

    expect(res.status).toBe(204);
    expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_ID);
    expect(deps.jobRepo.deleteWithData).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('returns 404 when job does not exist', async () => {
    (deps.jobRepo as any).findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/nonexistent', {
      method: 'DELETE',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
    expect(deps.jobRepo.deleteWithData).not.toHaveBeenCalled();
  });
});
