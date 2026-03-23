import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { actionRoutes } from '../../../src/routes/actions.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { Pool } from 'pg';

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
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

  describe('with ReviewQueue', () => {
    let depsWithQueue: AppDeps;
    let appWithQueue: ReturnType<typeof createTestApp>;

    beforeEach(() => {
      depsWithQueue = {
        ...createMockDeps(),
        reviewQueue: {
          enqueue: vi.fn().mockResolvedValue(undefined),
          getPending: vi.fn().mockResolvedValue([]),
          approve: vi.fn().mockResolvedValue({ id: 'act-1', status: 'approved' }),
          reject: vi.fn().mockResolvedValue(undefined),
          approveAll: vi.fn().mockResolvedValue([
            { id: 'act-1', status: 'approved' },
            { id: 'act-2', status: 'approved' },
          ]),
        },
      } as unknown as AppDeps;
      appWithQueue = createTestApp(depsWithQueue);
    });

    it('POST approve delegates to reviewQueue.approve', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'user-1' }),
      });

      expect(res.status).toBe(200);
      expect(depsWithQueue.reviewQueue!.approve).toHaveBeenCalledWith('act-1', 'tenant-1', 'user-1');
      // Should NOT fall through to direct actionRepo
      expect(depsWithQueue.actionRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('POST approve delegates to reviewQueue.approve without reviewedBy', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/act-1/approve', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(depsWithQueue.reviewQueue!.approve).toHaveBeenCalledWith('act-1', 'tenant-1', undefined);
    });

    it('POST reject delegates to reviewQueue.reject with reason', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/act-1/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'user-1', reason: 'Not needed' }),
      });

      expect(res.status).toBe(200);
      expect(depsWithQueue.reviewQueue!.reject).toHaveBeenCalledWith('act-1', 'tenant-1', 'user-1', 'Not needed');
      expect(depsWithQueue.actionRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('POST reject with no body still works', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/act-1/reject', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(depsWithQueue.reviewQueue!.reject).toHaveBeenCalledWith('act-1', 'tenant-1', undefined, '');
    });

    it('POST approve-all delegates to reviewQueue.approveAll', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/approve-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'user-1' }),
      });

      expect(res.status).toBe(200);
      expect(depsWithQueue.reviewQueue!.approveAll).toHaveBeenCalledWith('job-1', 'tenant-1', 'user-1');
      // Should NOT fall through to direct actionRepo
      expect(depsWithQueue.actionRepo.findByJob).not.toHaveBeenCalled();
      expect(depsWithQueue.actionRepo.batchUpdateStatus).not.toHaveBeenCalled();
    });

    it('POST approve-all returns ReviewQueue results', async () => {
      const res = await appWithQueue.request('/api/v1/jobs/job-1/actions/approve-all', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });
  });
});
