import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { schemaRoutes } from '../../../src/routes/schemas.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 3,
        definition: { version: 3, fields: [] },
      }),
      findAllVersions: vi.fn().mockResolvedValue([
        { id: 'schema-1', version: 1 },
        { id: 'schema-2', version: 2 },
        { id: 'schema-3', version: 3 },
      ]),
      findByVersion: vi.fn().mockResolvedValue({
        id: 'schema-2',
        version: 2,
        definition: { version: 2, fields: [] },
      }),
    },
    jobRepo: {} as any,
    jobManager: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
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
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  return app;
}

describe('Schema routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/schema', () => {
    it('returns current (latest) schema', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.version).toBe(3);
      expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns 404 when no schema exists', async () => {
      (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/job-1/schema');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('SCHEMA.NOT_FOUND');
    });
  });

  describe('GET /api/v1/jobs/:jobId/schema/versions', () => {
    it('returns all schema versions', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(3);
      expect(deps.schemaRepo.findAllVersions).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns empty array when no versions exist', async () => {
      (deps.schemaRepo.findAllVersions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const res = await app.request('/api/v1/jobs/job-1/schema/versions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /api/v1/jobs/:jobId/schema/versions/:version', () => {
    it('returns specific schema version', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.version).toBe(2);
      expect(deps.schemaRepo.findByVersion).toHaveBeenCalledWith('job-1', TENANT_ID, 2);
    });

    it('returns 404 for missing version', async () => {
      (deps.schemaRepo.findByVersion as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/99');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('SCHEMA.NOT_FOUND');
    });

    it('returns 400 for non-numeric version', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/abc');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION.PARAMS');
    });

    it('returns 400 for zero version', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/0');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION.PARAMS');
    });

    it('returns 400 for negative version', async () => {
      const res = await app.request('/api/v1/jobs/job-1/schema/versions/-1');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION.PARAMS');
    });
  });
});
