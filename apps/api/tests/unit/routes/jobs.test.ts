import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jobRoutes } from '../../../src/routes/jobs.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
  return {
    jobRepo: {
      create: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test', status: 'pending' }),
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'job-1', name: 'Test', status: 'pending', tenantId: TENANT_ID }),
      findByTenant: vi
        .fn()
        .mockResolvedValue([{ id: 'job-1', name: 'Test', status: 'pending' }]),
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
  app.route('/api/v1/jobs', jobRoutes());
  return app;
}

const validJobBody = {
  name: 'Test Job',
  description: 'Scrape product data',
  seedUrls: ['https://example.com'],
  crawl: {
    maxDepth: 2,
    maxPages: 100,
    concurrency: 5,
    crawlerType: 'playwright' as const,
  },
  schema: {
    mode: 'discovery' as const,
  },
  llm: {
    primaryModel: 'anthropic/claude-sonnet-4-20250514',
  },
};

describe('Job Routes', () => {
  let deps: AppDeps;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('POST /api/v1/jobs', () => {
    it('creates a job and returns 201', async () => {
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validJobBody),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data).toBeDefined();
      expect(json.data.id).toBe('job-1');

      expect(deps.jobManager.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          name: 'Test Job',
          seedUrls: ['https://example.com'],
        }),
      );
      expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns 400 for invalid body — missing name', async () => {
      const { name: _, ...bodyWithoutName } = validJobBody;
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyWithoutName),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid body — empty seedUrls', async () => {
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validJobBody, seedUrls: [] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid body — bad URL in seedUrls', async () => {
      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validJobBody, seedUrls: ['not-a-url'] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('applies defaults for optional crawl fields', async () => {
      const minimalBody = {
        name: 'Minimal Job',
        description: 'Minimal test',
        seedUrls: ['https://example.com'],
        crawl: {},
        schema: { mode: 'discovery' },
        llm: {},
      };

      const res = await app.request('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(minimalBody),
      });

      expect(res.status).toBe(201);
      expect(deps.jobManager.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          crawl: expect.objectContaining({
            maxDepth: 2,
            maxPages: 1000,
            concurrency: 5,
            crawlerType: 'playwright',
          }),
        }),
      );
    });
  });

  describe('GET /api/v1/jobs', () => {
    it('returns list of jobs', async () => {
      const res = await app.request('/api/v1/jobs');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toBeInstanceOf(Array);
      expect(json.data).toHaveLength(1);
      expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(TENANT_ID, {
        status: undefined,
        limit: 50,
      });
    });

    it('passes status filter to repository', async () => {
      const res = await app.request('/api/v1/jobs?status=running');

      expect(res.status).toBe(200);
      expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(TENANT_ID, {
        status: 'running',
        limit: 50,
      });
    });

    it('passes limit to repository', async () => {
      const res = await app.request('/api/v1/jobs?limit=10');

      expect(res.status).toBe(200);
      expect(deps.jobRepo.findByTenant).toHaveBeenCalledWith(TENANT_ID, {
        status: undefined,
        limit: 10,
      });
    });

    it('returns 400 for invalid status filter', async () => {
      const res = await app.request('/api/v1/jobs?status=invalid');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/jobs/:id', () => {
    it('returns job details', async () => {
      const res = await app.request('/api/v1/jobs/job-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns 404 for missing job', async () => {
      (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const res = await app.request('/api/v1/jobs/nonexistent');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/jobs/:id/start', () => {
    it('starts a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/start', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(json.data.message).toBe('Job started');
      expect(deps.jobManager.startJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });
  });

  describe('POST /api/v1/jobs/:id/pause', () => {
    it('pauses a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/pause', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(json.data.message).toBe('Job paused');
      expect(deps.jobManager.pauseJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });
  });

  describe('POST /api/v1/jobs/:id/resume', () => {
    it('resumes a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/resume', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(json.data.message).toBe('Job resumed');
      expect(deps.jobManager.resumeJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });
  });

  describe('POST /api/v1/jobs/:id/cancel', () => {
    it('cancels a job', async () => {
      const res = await app.request('/api/v1/jobs/job-1/cancel', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(json.data.message).toBe('Job cancelled');
      expect(deps.jobManager.cancelJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });
  });

  describe('POST /api/v1/jobs/:id/reconcile', () => {
    it('triggers reconciliation', async () => {
      const res = await app.request('/api/v1/jobs/job-1/reconcile', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe('job-1');
      expect(json.data.message).toBe('Reconciliation triggered');
      expect(deps.jobManager.triggerReconciliation).toHaveBeenCalledWith(
        'job-1',
        TENANT_ID,
      );
    });
  });
});
