import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { extractionRoutes } from '../../../src/routes/extractions.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([
        { id: 'ext-1', data: { name: 'Product A' }, schemaVersion: 1 },
        { id: 'ext-2', data: { name: 'Product B' }, schemaVersion: 1 },
      ]),
    },
    jobRepo: {} as any,
    schemaRepo: {} as any,
    entityRepo: {} as any,
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
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  return app;
}

describe('Extraction routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/extractions', () => {
    it('returns extractions list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/extractions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('passes schemaVersion filter', async () => {
      await app.request('/api/v1/jobs/job-1/extractions?schemaVersion=2');
      expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ schemaVersion: 2 }),
      );
    });

    it('passes limit parameter', async () => {
      await app.request('/api/v1/jobs/job-1/extractions?limit=10');
      expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ limit: 10 }),
      );
    });

    it('applies default limit of 50', async () => {
      await app.request('/api/v1/jobs/job-1/extractions');
      expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('returns 400 for invalid schemaVersion', async () => {
      const res = await app.request('/api/v1/jobs/job-1/extractions?schemaVersion=abc');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for limit exceeding max', async () => {
      const res = await app.request('/api/v1/jobs/job-1/extractions?limit=200');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
