import { Hono } from 'hono';
import { JobConfig } from '@spatula/core';
import type { AppEnv } from '../types.js';
import { createJobSchema, listJobsQuerySchema } from '../schemas/job.js';
import type { CreateJobBody, ListJobsQuery } from '../schemas/job.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function jobRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST / — Create job
  router.post('/', validateBody(createJobSchema), async (c) => {
    const body = c.get('validatedBody') as CreateJobBody;
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    // Parse through the core JobConfig schema so all core defaults
    // (e.g. evolutionConfig.relevanceThresholds, tableStrategy) are applied.
    const config = JobConfig.parse({ tenantId, ...body });
    const jobId = await deps.jobManager.createJob(config);
    const job = await deps.jobRepo.findById(jobId, tenantId);

    return c.json({ data: job }, 201);
  });

  // GET / — List jobs
  router.get('/', validateQuery(listJobsQuerySchema), async (c) => {
    const query = c.get('validatedQuery') as ListJobsQuery;
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit,
    });

    return c.json({ data: jobs });
  });

  // GET /:id — Get job details
  router.get('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new NotFoundError('Job', jobId);
    }

    return c.json({ data: job });
  });

  // POST /:id/start
  router.post('/:id/start', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');
    await deps.jobManager.startJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job started' } });
  });

  // POST /:id/pause
  router.post('/:id/pause', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');
    await deps.jobManager.pauseJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job paused' } });
  });

  // POST /:id/resume
  router.post('/:id/resume', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');
    await deps.jobManager.resumeJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job resumed' } });
  });

  // POST /:id/cancel
  router.post('/:id/cancel', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');
    await deps.jobManager.cancelJob(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Job cancelled' } });
  });

  // POST /:id/reconcile
  router.post('/:id/reconcile', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('id');
    await deps.jobManager.triggerReconciliation(jobId, tenantId);
    return c.json({ data: { id: jobId, message: 'Reconciliation triggered' } });
  });

  return router;
}
