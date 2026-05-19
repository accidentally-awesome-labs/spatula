import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { entityRoutes } from '../../../src/routes/entities.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import { encodeCursor } from '@spatula/shared';
import type { Pool } from 'pg';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    entityRepo: {
      findByJob: vi
        .fn()
        .mockResolvedValue([
          { id: 'ent-1', mergedData: { name: 'Product A' }, qualityScore: 0.95 },
        ]),
      findById: vi.fn().mockResolvedValue({
        id: 'ent-1',
        mergedData: { name: 'Product A' },
        provenance: { name: { provenanceType: 'extracted' } },
        qualityScore: 0.95,
      }),
      countByJob: vi.fn().mockResolvedValue(42),
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [], nextCursor: null }),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([{ extractionId: 'ext-1', matchConfidence: 0.9 }]),
      findByEntityWithUrls: vi
        .fn()
        .mockResolvedValue([
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
      expect(body.error.code).toBe('VALIDATION.SCHEMA');
    });

    it('returns total count alongside data in pagination envelope', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.total).toBe(42);
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

    it('uses cursor pagination when cursor query param is provided', async () => {
      const cursorId = '550e8400-e29b-41d4-a716-446655440000';
      const cursor = encodeCursor({ id: cursorId });
      const mockEntities = [
        { id: 'ent-2', mergedData: { name: 'Product B' }, qualityScore: 0.8 },
        { id: 'ent-3', mergedData: { name: 'Product C' }, qualityScore: 0.7 },
      ];
      (deps.entityRepo.findByJobCursor as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        entities: mockEntities,
        nextCursor: 'ent-3',
      });

      const res = await app.request(`/api/v1/jobs/job-1/entities?cursor=${cursor}`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.data).toHaveLength(2);
      expect(body.pagination.hasMore).toBe(true);
      expect(body.pagination.nextCursor).toBeDefined();
      expect(deps.entityRepo.findByJobCursor).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        50,
        cursorId,
        undefined,
      );
      // findByJob should NOT have been called
      expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    });

    it('uses since filter without cursor', async () => {
      (deps.entityRepo.findByJobCursor as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        entities: [],
        nextCursor: null,
      });

      const res = await app.request('/api/v1/jobs/job-1/entities?since=2026-03-01T00:00:00Z');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.pagination.hasMore).toBe(false);
      expect(deps.entityRepo.findByJobCursor).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        50,
        undefined,
        '2026-03-01T00:00:00Z',
      );
      expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    });

    it('passes both cursor and since to findByJobCursor', async () => {
      const cursorId = '550e8400-e29b-41d4-a716-446655440000';
      const cursor = encodeCursor({ id: cursorId });
      (deps.entityRepo.findByJobCursor as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        entities: [{ id: 'ent-4', mergedData: {}, qualityScore: 0.5 }],
        nextCursor: null,
      });

      const res = await app.request(
        `/api/v1/jobs/job-1/entities?cursor=${cursor}&since=2026-03-01T00:00:00Z`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.pagination.hasMore).toBe(false);
      expect(body.pagination.nextCursor).toBeUndefined();
      expect(deps.entityRepo.findByJobCursor).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
        50,
        cursorId,
        '2026-03-01T00:00:00Z',
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
      expect(body.error.code).toBe('ENTITY.NOT_FOUND');
    });
  });
});
