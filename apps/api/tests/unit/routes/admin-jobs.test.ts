import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const SAMPLE_JOB = {
  id: 'job-1',
  tenantId: TENANT_ID,
  name: 'Test crawl',
  status: 'running',
  createdAt: new Date('2026-03-28T10:00:00Z'),
  startedAt: new Date('2026-03-28T10:01:00Z'),
  completedAt: null,
  config: {},
  stats: {},
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn(),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
      findAll: vi.fn().mockResolvedValue([SAMPLE_JOB]),
      countAll: vi.fn().mockResolvedValue(1),
      forceCancel: vi.fn().mockResolvedValue({ ...SAMPLE_JOB, status: 'cancelled', completedAt: new Date() }),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: { createJob: vi.fn(), startJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), cancelJob: vi.fn(), triggerReconciliation: vi.fn() } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, name: 'Test Tenant', config: {} }),
    } as any,
    auditLogger: {
      log: vi.fn(),
    } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/jobs', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns cross-tenant job list with pagination', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: 'job-1',
      tenantId: TENANT_ID,
      name: 'Test crawl',
      status: 'running',
      createdAt: SAMPLE_JOB.createdAt.toISOString(),
      startedAt: SAMPLE_JOB.startedAt.toISOString(),
      completedAt: null,
    });
    expect(body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it('passes status and tenantId filters to repo', async () => {
    const app = createApp(deps);
    await app.request(
      `/api/v1/admin/jobs?status=running&tenantId=${TENANT_ID}&limit=10&offset=5`,
      { headers: tenantHeader },
    );

    expect((deps.jobRepo as any).findAll).toHaveBeenCalledWith({
      status: 'running',
      tenantId: TENANT_ID,
      limit: 10,
      offset: 5,
    });
    expect((deps.jobRepo as any).countAll).toHaveBeenCalledWith({
      status: 'running',
      tenantId: TENANT_ID,
    });
  });

  it('clamps limit to max 100', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/jobs?limit=500', { headers: tenantHeader });

    expect((deps.jobRepo as any).findAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('defaults limit=50 and offset=0', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/jobs', { headers: tenantHeader });

    expect((deps.jobRepo as any).findAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });
});

describe('POST /api/v1/admin/jobs/:id/force-cancel', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('force-cancels a job and logs audit event', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/job-1/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
    expect((deps.jobRepo as any).forceCancel).toHaveBeenCalledWith('job-1');
    expect((deps.auditLogger as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: 'admin.job.force_cancel',
        resourceType: 'job',
        resourceId: 'job-1',
      }),
    );
  });

  it('returns 404 for nonexistent job', async () => {
    (deps.jobRepo as any).forceCancel = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/nonexistent/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('drains matching BullMQ jobs from queues when available', async () => {
    const mockQueueJob = {
      data: { jobId: 'job-1' },
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const nonMatchingJob = {
      data: { jobId: 'other-job' },
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const makeQueue = () => ({
      getJobs: vi.fn().mockResolvedValue([mockQueueJob, nonMatchingJob]),
    });

    deps = createMockDeps({
      queues: {
        crawl: makeQueue(),
        extract: makeQueue(),
        schemaEvolution: makeQueue(),
        reconciliation: makeQueue(),
        export: makeQueue(),
        webhook: makeQueue(),
        config: {} as any,
        closeAll: vi.fn(),
      } as any,
    });

    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/job-1/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    // Only matching jobs should be removed
    expect(mockQueueJob.remove).toHaveBeenCalled();
    expect(nonMatchingJob.remove).not.toHaveBeenCalled();
  });

  it('does not fail when queues are unavailable', async () => {
    // No queues in deps — should not throw
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/jobs/job-1/force-cancel', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
  });
});
