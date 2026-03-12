import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { entityRoutes } from '../../../src/routes/entities.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
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
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([
        { extractionId: 'ext-1', matchConfidence: 0.9 },
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

    it('calls entitySourceRepo.findByEntity with the entity id', async () => {
      await app.request('/api/v1/jobs/job-1/entities/ent-1');
      expect(deps.entitySourceRepo.findByEntity).toHaveBeenCalledWith('ent-1');
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
