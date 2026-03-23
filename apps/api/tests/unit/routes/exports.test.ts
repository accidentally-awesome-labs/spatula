import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { exportRoutes } from '../../../src/routes/exports.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { Pool } from 'pg';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    exportRepo: {
      create: vi.fn().mockResolvedValue({
        id: 'exp-1', status: 'pending', format: 'json',
        includeProvenance: false, createdAt: new Date().toISOString(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'exp-1', jobId: 'job-1', status: 'completed', format: 'json',
        includeProvenance: false, entityCount: 42, fileSize: 1024,
        contentRef: 'pg://ref-1', createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
      findByJob: vi.fn().mockResolvedValue([]),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        definition: {
          version: 1,
          fields: [{ name: 'name', description: 'Name', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
    },
    contentStore: {
      retrieve: vi.fn().mockResolvedValue('{"entities":[]}'),
      retrieveBinary: vi.fn().mockResolvedValue(null),
    },
    exportQueue: {
      add: vi.fn().mockResolvedValue({ id: 'bull-job-1' }),
    },
    jobRepo: {} as any,
    extractionRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', TENANT_ID);
    return next();
  });
  app.route('/api/v1/jobs/:jobId', exportRoutes());
  return app;
}

describe('Export routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('POST /export', () => {
    it('creates export and returns 202', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'json' }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.data.id).toBe('exp-1');
      expect(body.data.status).toBe('pending');
    });

    it('enqueues BullMQ job', async () => {
      await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv' }),
      });
      expect(deps.exportQueue.add).toHaveBeenCalled();
    });

    it('returns 400 for invalid format', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'xlsx' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /export/:exportId', () => {
    it('returns export status', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('completed');
      expect(body.data.entityCount).toBe(42);
    });

    it('returns 404 for missing export', async () => {
      (deps.exportRepo.findById as any).mockResolvedValueOnce(null);
      const res = await app.request('/api/v1/jobs/job-1/export/missing');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /export/:exportId/download', () => {
    it('returns file content with headers', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1/download');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-disposition')).toContain('attachment');
    });

    it('returns 409 when export not completed', async () => {
      (deps.exportRepo.findById as any).mockResolvedValueOnce({ id: 'exp-1', status: 'processing' });
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1/download');
      expect(res.status).toBe(409);
    });

    it('returns 404 for missing export', async () => {
      (deps.exportRepo.findById as any).mockResolvedValueOnce(null);
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1/download');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /documentation', () => {
    it('returns data dictionary', async () => {
      const res = await app.request('/api/v1/jobs/job-1/documentation');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.fields).toBeDefined();
      expect(body.data.schemaVersion).toBeDefined();
    });

    it('returns 404 when no schema exists', async () => {
      (deps.schemaRepo.findLatest as any).mockResolvedValueOnce(null);
      const res = await app.request('/api/v1/jobs/job-1/documentation');
      expect(res.status).toBe(404);
    });
  });
});
