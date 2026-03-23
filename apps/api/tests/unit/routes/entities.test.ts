import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { entityRoutes } from '../../../src/routes/entities.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { Pool } from 'pg';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([
        { id: 'ent-1', mergedData: { name: 'Product A' }, qualityScore: 0.95 },
      ]),
      findById: vi.fn().mockResolvedValue({
        id: 'ent-1',
        mergedData: { name: 'Product A' },
        provenance: { name: { provenanceType: 'extracted' } },
        qualityScore: 0.95,
      }),
      countByJob: vi.fn().mockResolvedValue(42),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([
        { extractionId: 'ext-1', matchConfidence: 0.9 },
      ]),
      findByEntityWithUrls: vi.fn().mockResolvedValue([
        { extractionId: 'ext-1', matchConfidence: 0.9, sourceUrl: 'https://example.com' },
      ]),
    },
    jobRepo: {} as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
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
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  return app;
}

describe('Entity routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/entities', () => {
    it('returns entities list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('passes pagination params', async () => {
      await app.request('/api/v1/jobs/job-1/entities?limit=10&offset=5');
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ limit: 10, offset: 5 }),
      );
    });

    it('applies default pagination', async () => {
      await app.request('/api/v1/jobs/job-1/entities');
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ limit: 50, offset: 0 }),
      );
    });

    it('returns 400 for invalid offset', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities?offset=-1');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns total count alongside data', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(42);
      expect(body.data).toHaveLength(1);
    });

    it('passes search param to repo', async () => {
      await app.request('/api/v1/jobs/job-1/entities?search=bluetooth');
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ search: 'bluetooth' }),
      );
      expect(deps.entityRepo.countByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        expect.objectContaining({ search: 'bluetooth' }),
      );
    });
  });

  describe('GET /api/v1/jobs/:jobId/entities/:entityId', () => {
    it('returns entity with provenance and sources', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities/ent-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('ent-1');
      expect(body.data.sources).toHaveLength(1);
      expect(body.data.provenance).toBeDefined();
    });

    it('uses findByEntityWithUrls for entity detail', async () => {
      await app.request('/api/v1/jobs/job-1/entities/ent-1');
      expect(deps.entitySourceRepo.findByEntityWithUrls).toHaveBeenCalledWith('ent-1');
    });

    it('returns 404 for missing entity', async () => {
      (deps.entityRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const res = await app.request('/api/v1/jobs/job-1/entities/missing');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});
