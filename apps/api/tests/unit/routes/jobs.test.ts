import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn(),
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

describe('PATCH /api/v1/jobs/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('dispatches start action to jobManager', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    const body = await res.json();
    expect(body.data.action).toBe('start');
  });

  it('dispatches pause action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.pauseJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('dispatches resume action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.resumeJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('dispatches cancel action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.cancelJob).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('dispatches reconcile action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile' }),
    });

    expect(res.status).toBe(200);
    expect(deps.jobManager.triggerReconciliation).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('rejects invalid action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invalid' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects missing action', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'PATCH',
      headers: { 'x-tenant-id': TENANT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
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
      headers: { 'x-tenant-id': TENANT_ID },
    });

    expect(res.status).toBe(204);
    expect(deps.jobRepo.deleteWithData).toHaveBeenCalledWith('job-1', TENANT_ID);
  });

  it('propagates errors from deleteWithData', async () => {
    (deps.jobRepo as any).deleteWithData = vi.fn().mockRejectedValue(new Error('Job not found'));
    const app = createApp(deps);
    const res = await app.request('/api/v1/jobs/job-1', {
      method: 'DELETE',
      headers: { 'x-tenant-id': TENANT_ID },
    });

    expect(res.status).toBe(500);
  });
});
