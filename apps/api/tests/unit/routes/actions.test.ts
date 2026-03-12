import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { actionRoutes } from '../../../src/routes/actions.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createMockDeps(): AppDeps {
  return {
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([
        { id: 'act-1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
      ]),
      findById: vi.fn().mockResolvedValue({
        id: 'act-1',
        type: 'add_field',
        status: 'pending_review',
        confidence: 0.9,
        tenantId: 'tenant-1',
      }),
      updateStatus: vi.fn().mockResolvedValue({
        id: 'act-1',
        status: 'approved',
      }),
      batchUpdateStatus: vi.fn().mockResolvedValue([
        { id: 'act-1', status: 'approved' },
        { id: 'act-2', status: 'approved' },
      ]),
    },
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  return app;
}

describe('Action routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('GET /api/v1/jobs/:jobId/actions', () => {
    it('returns actions list', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('passes type and status filters', async () => {
      await app.request('/api/v1/jobs/job-1/actions?type=add_field&status=pending_review');
      expect(deps.actionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ type: 'add_field', status: 'pending_review' }),
      );
    });

    it('passes pagination params', async () => {
      await app.request('/api/v1/jobs/job-1/actions?limit=10&offset=5');
      expect(deps.actionRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        'tenant-1',
        expect.objectContaining({ limit: 10, offset: 5 }),
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/:actionId/approve', () => {
    it('approves an action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'approved',
        undefined,
      );
    });

    it('passes reviewedBy from body', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'user-1' }),
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'approved',
        'user-1',
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/:actionId/reject', () => {
    it('rejects an action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/act-1/reject', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'act-1',
        'tenant-1',
        'rejected',
        undefined,
      );
    });
  });

  describe('POST /api/v1/jobs/:jobId/actions/approve-all', () => {
    it('batch approves pending actions', async () => {
      (deps.actionRepo.findByJob as any).mockResolvedValue([
        { id: 'act-1', status: 'pending_review' },
        { id: 'act-2', status: 'pending_review' },
      ]);

      const res = await app.request('/api/v1/jobs/job-1/actions/approve-all', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(deps.actionRepo.batchUpdateStatus).toHaveBeenCalledWith(
        ['act-1', 'act-2'],
        'tenant-1',
        'approved',
        undefined,
      );
    });

    it('returns empty array when no pending actions', async () => {
      (deps.actionRepo.findByJob as any).mockResolvedValue([]);
      const res = await app.request('/api/v1/jobs/job-1/actions/approve-all', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });
});
