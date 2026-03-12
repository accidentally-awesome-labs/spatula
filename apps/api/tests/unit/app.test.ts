import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      findById: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', tenantId: 'tenant-1' }),
      findByTenant: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(null),
      findAllVersions: vi.fn().mockResolvedValue([]),
      findByVersion: vi.fn().mockResolvedValue(null),
    },
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    taskRepo: {},
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
  } as unknown as AppDeps;
}

describe('Full app', () => {
  it('health check works without tenant header', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('returns 400 when tenant header missing on API routes', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs');
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/jobs works with tenant header', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/jobs/:id returns job detail', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('job-1');
  });

  it('GET /api/v1/jobs/:id/schema returns 404 when no schema', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/schema', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/jobs/:id/extractions returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/extractions', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('GET /api/v1/jobs/:id/entities returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/entities', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/jobs/:id/actions returns empty list', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/actions', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
  });
});
