import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { JobConfig } from '@spatula/core';
import type { AppEnv } from '../types.js';
import { createJobSchema, listJobsQuerySchema, patchJobSchema } from '../schemas/job.js';
import { jobResponseSchema, errorResponseSchema, dataResponse, listResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

// --- Route definitions ---

const idParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: '550e8400-e29b-41d4-a716-446655440000' }),
});

const actionMessageSchema = z.object({ data: z.object({ id: z.string(), message: z.string() }) });
const patchResponseSchema = z.object({ data: z.object({ id: z.string(), action: z.string(), message: z.string() }) });

const createJobRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Jobs'],
  summary: 'Create a new crawl job',
  request: {
    body: { content: { 'application/json': { schema: createJobSchema } }, required: true },
  },
  responses: {
    201: jsonContent(dataResponse(jobResponseSchema), 'Job created'),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const listJobsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Jobs'],
  summary: 'List jobs for the current tenant',
  request: { query: listJobsQuerySchema },
  responses: { 200: jsonContent(listResponse(jobResponseSchema), 'List of jobs') },
});

const getJobRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Get job details',
  request: { params: idParam },
  responses: {
    200: jsonContent(dataResponse(jobResponseSchema), 'Job details'),
    404: jsonContent(errorResponseSchema, 'Job not found'),
  },
});

const patchJobRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Control job (start, pause, resume, cancel, reconcile)',
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: patchJobSchema } }, required: true },
  },
  responses: {
    200: jsonContent(patchResponseSchema, 'Action executed'),
    400: jsonContent(errorResponseSchema, 'Invalid action'),
  },
});

const deleteJobRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Delete job and all related data',
  request: { params: idParam },
  responses: {
    204: { description: 'Job deleted' },
    404: jsonContent(errorResponseSchema, 'Job not found'),
  },
});

// Legacy POST aliases
const startJobRoute = createRoute({ method: 'post', path: '/{id}/start', tags: ['Jobs'], summary: 'Start job (alias for PATCH)',
  request: { params: idParam }, responses: { 200: jsonContent(actionMessageSchema, 'Job started') } });
const pauseJobRoute = createRoute({ method: 'post', path: '/{id}/pause', tags: ['Jobs'], summary: 'Pause job (alias for PATCH)',
  request: { params: idParam }, responses: { 200: jsonContent(actionMessageSchema, 'Job paused') } });
const resumeJobRoute = createRoute({ method: 'post', path: '/{id}/resume', tags: ['Jobs'], summary: 'Resume job (alias for PATCH)',
  request: { params: idParam }, responses: { 200: jsonContent(actionMessageSchema, 'Job resumed') } });
const cancelJobRoute = createRoute({ method: 'post', path: '/{id}/cancel', tags: ['Jobs'], summary: 'Cancel job (alias for PATCH)',
  request: { params: idParam }, responses: { 200: jsonContent(actionMessageSchema, 'Job cancelled') } });
const reconcileJobRoute = createRoute({ method: 'post', path: '/{id}/reconcile', tags: ['Jobs'], summary: 'Trigger reconciliation (alias for PATCH)',
  request: { params: idParam }, responses: { 200: jsonContent(actionMessageSchema, 'Reconciliation triggered') } });

// --- Handlers ---

export function jobRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createJobRoute, async (c) => {
    const body = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const config = JobConfig.parse({ tenantId, ...body });
    const jobId = await deps.jobManager.createJob(config);
    const job = await deps.jobRepo.findById(jobId, tenantId);

    return c.json({ data: job }, 201);
  });

  router.openapi(listJobsRoute, async (c) => {
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: jobs });
  });

  router.openapi(getJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new NotFoundError('Job', id);

    return c.json({ data: job });
  });

  router.openapi(patchJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { action } = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const handlers: Record<string, () => Promise<void>> = {
      start: () => deps.jobManager.startJob(id, tenantId),
      pause: () => deps.jobManager.pauseJob(id, tenantId),
      resume: () => deps.jobManager.resumeJob(id, tenantId),
      cancel: () => deps.jobManager.cancelJob(id, tenantId),
      reconcile: () => deps.jobManager.triggerReconciliation(id, tenantId),
    };

    await handlers[action]();
    return c.json({ data: { id, action, message: `Job ${action} successful` } });
  });

  router.openapi(deleteJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new NotFoundError('Job', id);

    await deps.jobRepo.deleteWithData(id, tenantId);
    return c.body(null, 204);
  });

  // Legacy POST aliases
  router.openapi(startJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.startJob(id, tenantId);
    return c.json({ data: { id, message: 'Job started' } });
  });
  router.openapi(pauseJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.pauseJob(id, tenantId);
    return c.json({ data: { id, message: 'Job paused' } });
  });
  router.openapi(resumeJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.resumeJob(id, tenantId);
    return c.json({ data: { id, message: 'Job resumed' } });
  });
  router.openapi(cancelJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.cancelJob(id, tenantId);
    return c.json({ data: { id, message: 'Job cancelled' } });
  });
  router.openapi(reconcileJobRoute, async (c) => {
    const { id } = c.req.valid('param'); const tenantId = c.get('tenantId'); const deps = c.get('deps');
    await deps.jobManager.triggerReconciliation(id, tenantId);
    return c.json({ data: { id, message: 'Reconciliation triggered' } });
  });

  return router;
}
