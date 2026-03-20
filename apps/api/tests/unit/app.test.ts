import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      findById: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', tenantId: 'tenant-1' }),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
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
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([]),
      findByEntityWithUrls: vi.fn().mockResolvedValue([]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    taskRepo: {},
    exportRepo: { create: vi.fn(), findById: vi.fn(), findByJob: vi.fn(), updateStatus: vi.fn() },
    contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() },
    exportQueue: { add: vi.fn() },
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

  it('GET /api/openapi.json returns OpenAPI spec without auth', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Spatula API');
    expect(body.paths).toBeDefined();
  });

  it('GET /api/docs returns Swagger UI without auth', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('swagger');
  });

  it('GET /api/v1/jobs returns total count alongside data', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('data');
  });

  it('GET /api/v1/jobs/:id/extractions returns total count', async () => {
    const app = createApp(createMockDeps());
    const res = await app.request('/api/v1/jobs/job-1/extractions', {
      headers: { 'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total');
  });
});
