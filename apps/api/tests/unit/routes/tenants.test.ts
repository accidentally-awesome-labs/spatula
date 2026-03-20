import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';

function createMockDeps(): AppDeps {
  return {
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
  });
});
