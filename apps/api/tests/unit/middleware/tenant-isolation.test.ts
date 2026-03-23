import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jobRoutes } from '../../../src/routes/jobs.js';
import { entityRoutes } from '../../../src/routes/entities.js';
import { actionRoutes } from '../../../src/routes/actions.js';
import { tenantMiddleware } from '../../../src/middleware/tenant.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { StorageError } from '@spatula/shared';
import type { Pool } from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

const jobForTenantA = {
  id: 'job-1',
  name: 'Tenant A Job',
  status: 'running',
  tenantId: TENANT_A,
};

function createMockDeps(): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      create: vi.fn().mockResolvedValue(jobForTenantA),
      findById: vi.fn().mockImplementation((jobId: string, tenantId: string) => {
        if (tenantId === TENANT_A && jobId === 'job-1') {
          return Promise.resolve(jobForTenantA);
        }
        return Promise.resolve(null);
      }),
      findByTenant: vi.fn().mockImplementation((tenantId: string) => {
        if (tenantId === TENANT_A) {
          return Promise.resolve([jobForTenantA]);
        }
        return Promise.resolve([]);
      }),
      countByTenant: vi.fn().mockImplementation((tenantId: string) => {
        return Promise.resolve(tenantId === TENANT_A ? 1 : 0);
      }),
      updateStatus: vi.fn().mockResolvedValue({ id: 'job-1', status: 'cancelled' }),
      updateStats: vi.fn().mockResolvedValue(null),
    },
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn().mockResolvedValue(undefined),
      pauseJob: vi.fn().mockResolvedValue(undefined),
      resumeJob: vi.fn().mockResolvedValue(undefined),
      cancelJob: vi.fn().mockResolvedValue(undefined),
      triggerReconciliation: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {
      findByJob: vi.fn().mockImplementation((jobId: string, tenantId: string) => {
        if (tenantId === TENANT_A && jobId === 'job-1') {
          return Promise.resolve([
            { id: 'entity-1', name: 'Product A', jobId: 'job-1' },
            { id: 'entity-2', name: 'Product B', jobId: 'job-1' },
          ]);
        }
        return Promise.resolve([]);
      }),
      countByJob: vi.fn().mockImplementation((jobId: string, tenantId: string) => {
        if (tenantId === TENANT_A && jobId === 'job-1') {
          return Promise.resolve(2);
        }
        return Promise.resolve(0);
      }),
      findById: vi.fn().mockResolvedValue(null),
    },
    entitySourceRepo: {
      findByEntityWithUrls: vi.fn().mockResolvedValue([]),
    } as any,
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockImplementation(
        (actionId: string, tenantId: string, _status: string) => {
          if (tenantId === TENANT_A && actionId === 'action-1') {
            return Promise.resolve({
              id: 'action-1',
              status: 'approved',
              tenantId: TENANT_A,
            });
          }
          throw new StorageError(`Action ${actionId} not found`, {
            context: { actionId, tenantId },
          });
        },
      ),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    taskRepo: {} as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
  } as unknown as AppDeps;
}

/**
 * Creates a test app that uses the real tenantMiddleware (extracts from header)
 * instead of hardcoding a tenant ID, so we can test cross-tenant isolation.
 */
function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', async (c, next) => {
    c.set('deps', deps);
    return next();
  });
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  return app;
}

describe('Cross-tenant isolation', () => {
  let deps: AppDeps;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('Jobs are scoped by tenant', () => {
    it('tenant-A sees their own jobs', async () => {
      const res = await app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': TENANT_A },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('job-1');
      expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(TENANT_A, {
        status: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('tenant-B sees empty results for tenant-A jobs', async () => {
      const res = await app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': TENANT_B },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(0);
      expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(TENANT_B, {
        status: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('passes the correct tenant ID on each call', async () => {
      await app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': TENANT_A },
      });
      await app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': TENANT_B },
      });

      expect(deps.jobRepo.findByTenant).toHaveBeenCalledTimes(2);
      expect(deps.jobRepo.findByTenant).toHaveBeenNthCalledWith(1, TENANT_A, expect.any(Object));
      expect(deps.jobRepo.findByTenant).toHaveBeenNthCalledWith(2, TENANT_B, expect.any(Object));
    });
  });

  describe('Job detail returns 404 for wrong tenant', () => {
    it('tenant-A can access their own job', async () => {
      const res = await app.request('/api/v1/jobs/job-1', {
        headers: { 'x-tenant-id': TENANT_A },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_A);
    });

    it('tenant-B gets 404 for tenant-A job', async () => {
      const res = await app.request('/api/v1/jobs/job-1', {
        headers: { 'x-tenant-id': TENANT_B },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
      expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_B);
    });
  });

  describe('Entity access is tenant-scoped', () => {
    it('tenant-A sees entities for their job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities', {
        headers: { 'x-tenant-id': TENANT_A },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(2);
      expect(json.data[0].id).toBe('entity-1');
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_A,
        expect.any(Object),
      );
    });

    it('tenant-B sees empty entities for tenant-A job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/entities', {
        headers: { 'x-tenant-id': TENANT_B },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(0);
      expect(deps.entityRepo.findByJob).toHaveBeenCalledWith(
        'job-1',
        TENANT_B,
        expect.any(Object),
      );
    });
  });

  describe('Action approval is tenant-scoped', () => {
    it('tenant-A can approve their own action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/action-1/approve', {
        method: 'POST',
        headers: {
          'x-tenant-id': TENANT_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('action-1');
      expect(json.data.status).toBe('approved');
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'action-1',
        TENANT_A,
        'approved',
        undefined,
      );
    });

    it('tenant-B gets error when approving tenant-A action', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/action-1/approve', {
        method: 'POST',
        headers: {
          'x-tenant-id': TENANT_B,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      // StorageError from the repo propagates as a 500
      expect(res.status).toBe(500);
      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'action-1',
        TENANT_B,
        'approved',
        undefined,
      );
    });
  });

  describe('Missing x-tenant-id header returns 400', () => {
    it('GET /api/v1/jobs without header returns 400', async () => {
      const res = await app.request('/api/v1/jobs');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('x-tenant-id');
    });

    it('GET /api/v1/jobs/:id without header returns 400', async () => {
      const res = await app.request('/api/v1/jobs/job-1');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/v1/jobs/:id/actions/:aid/approve without header returns 400', async () => {
      const res = await app.request('/api/v1/jobs/job-1/actions/action-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('invalid UUID in x-tenant-id returns 400', async () => {
      const res = await app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': 'not-a-uuid' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('UUID');
    });
  });
});
