import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { JobConfig } from '@spatula/core';
import {
  createJobSchema,
  isAllowedCreateJobSeedUrl,
  listJobsQuerySchema,
  patchJobSchema,
  PRIVATE_CRAWL_URL_REJECTION_MESSAGE,
} from '../schemas/job.js';
import {
  jobResponseSchema,
  errorResponseSchema,
  dataResponse,
  jsonContent,
} from '../schemas/responses.js';
import {
  decodeCursor,
  encodeCursor,
  JobNotFoundError,
  ValidationSchemaError,
} from '@spatula/shared';
import { applyDeprecationHeaders } from '../lib/deprecation-headers.js';
import type { AppDeps } from '../types.js';

type CrawlTaskStats = {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
};

const EMPTY_CRAWL_TASK_STATS: CrawlTaskStats = {
  pending: 0,
  inProgress: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
};

async function getCrawlTaskStats(
  deps: Pick<AppDeps, 'taskRepo'>,
  jobId: string,
  tenantId: string,
): Promise<CrawlTaskStats> {
  const getJobStats = deps.taskRepo?.getJobStats;
  if (typeof getJobStats !== 'function') {
    return { ...EMPTY_CRAWL_TASK_STATS };
  }

  return getJobStats.call(deps.taskRepo, jobId, tenantId);
}

// --- Route definitions ---

const idParam = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440000',
  }),
});

const actionMessageSchema = z.object({ data: z.object({ id: z.string(), message: z.string() }) });
const patchResponseSchema = z.object({
  data: z.object({ id: z.string(), action: z.string(), message: z.string() }),
});

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
  responses: {
    200: jsonContent(
      z.union([
        z.object({
          data: z.array(jobResponseSchema),
          nextCursor: z.string().optional(),
          hasMore: z.boolean(),
        }),
        z.object({
          data: z.array(jobResponseSchema),
          total: z.number(),
          page: z.number(),
          limit: z.number(),
          hasMore: z.boolean(),
        }),
      ]),
      'Cursor-paginated job list; explicit offset/page queries return deprecated offset envelope',
    ),
  },
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
const startJobRoute = createRoute({
  method: 'post',
  path: '/{id}/start',
  tags: ['Jobs'],
  summary: 'Start job (alias for PATCH)',
  request: { params: idParam },
  responses: { 200: jsonContent(actionMessageSchema, 'Job started') },
});
const pauseJobRoute = createRoute({
  method: 'post',
  path: '/{id}/pause',
  tags: ['Jobs'],
  summary: 'Pause job (alias for PATCH)',
  request: { params: idParam },
  responses: { 200: jsonContent(actionMessageSchema, 'Job paused') },
});
const resumeJobRoute = createRoute({
  method: 'post',
  path: '/{id}/resume',
  tags: ['Jobs'],
  summary: 'Resume job (alias for PATCH)',
  request: { params: idParam },
  responses: { 200: jsonContent(actionMessageSchema, 'Job resumed') },
});
const cancelJobRoute = createRoute({
  method: 'post',
  path: '/{id}/cancel',
  tags: ['Jobs'],
  summary: 'Cancel job (alias for PATCH)',
  request: { params: idParam },
  responses: { 200: jsonContent(actionMessageSchema, 'Job cancelled') },
});
const reconcileJobRoute = createRoute({
  method: 'post',
  path: '/{id}/reconcile',
  tags: ['Jobs'],
  summary: 'Trigger reconciliation (alias for PATCH)',
  request: { params: idParam },
  responses: { 200: jsonContent(actionMessageSchema, 'Reconciliation triggered') },
});

// --- Handlers ---

export function jobRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createJobRoute, async (c) => {
    const body = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const blockedSeedUrl = body.seedUrls.find((url) => !isAllowedCreateJobSeedUrl(url));
    if (blockedSeedUrl) {
      throw new ValidationSchemaError(PRIVATE_CRAWL_URL_REJECTION_MESSAGE, {
        context: { field: 'seedUrls', url: blockedSeedUrl },
      });
    }

    const config = JobConfig.parse({ tenantId, ...body });
    const jobId = await deps.jobManager.createJob(config);
    const job = await deps.jobRepo.findById(jobId, tenantId);

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.created',
        resourceType: 'job',
        resourceId: jobId,
      });
    }

    return c.json({ data: job }, 201);
  });

  router.openapi(listJobsRoute, async (c) => {
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    if (query.offset !== undefined || query.page !== undefined) {
      const page = query.page ?? Math.floor((query.offset ?? 0) / query.limit) + 1;
      const offset = query.offset ?? (page - 1) * query.limit;
      const [jobs, total] = await Promise.all([
        deps.jobRepo.findByTenant(tenantId, {
          status: query.status,
          limit: query.limit,
          offset,
        }),
        deps.jobRepo.countByTenant(tenantId, { status: query.status }),
      ]);

      applyDeprecationHeaders(c);

      return c.json({
        data: jobs,
        total,
        page,
        limit: query.limit,
        hasMore: offset + query.limit < total,
      });
    }

    const cursorPayload = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (typeof deps.jobRepo.findByTenantCursor === 'function') {
      const result = await deps.jobRepo.findByTenantCursor(tenantId, {
        status: query.status,
        limit: query.limit,
        cursor: cursorPayload,
        since: query.since,
      });

      return c.json({
        data: result.jobs,
        ...(result.nextCursor ? { nextCursor: encodeCursor(result.nextCursor) } : {}),
        hasMore: !!result.nextCursor,
      });
    }

    const jobs = await deps.jobRepo.findByTenant(tenantId, {
      status: query.status,
      limit: query.limit + 1,
      offset: 0,
    });
    const page = jobs.slice(0, query.limit);
    const last = page.at(-1);
    return c.json({
      data: page,
      ...(jobs.length > query.limit && last
        ? { nextCursor: encodeCursor({ id: last.id, sortValue: last.createdAt.toISOString() }) }
        : {}),
      hasMore: jobs.length > query.limit,
    });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new JobNotFoundError(id);

    // Enrich stats with pending actions count, schema field count, and crawl progress
    const pendingActionsCount = await deps.actionRepo.countByJobAndStatus(
      id,
      tenantId,
      'pending_review',
    );
    const latestSchema = await deps.schemaRepo.findLatest(id, tenantId);
    const schemaFieldCount = (latestSchema?.definition as any)?.fields?.length ?? 0;

    // Crawl-task progress (completed = pages crawled). Surfaced so clients can read
    // page counts over HTTP (the API/worker path does not persist these into job.stats).
    const taskStats = await getCrawlTaskStats(deps, id, tenantId);

    const enrichedStats = {
      ...((job.stats as Record<string, number>) ?? {}),
      pendingActionsCount,
      schemaFieldCount,
      pagesCompleted: taskStats.completed,
      pagesPending: taskStats.pending,
      pagesInProgress: taskStats.inProgress,
      pagesFailed: taskStats.failed,
      pagesSkipped: taskStats.skipped,
      // storageBytesUsed: deferred — requires raw_pages SUM query not available in current deps
    };

    return c.json({ data: { ...job, stats: enrichedStats } });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(patchJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { action } = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new JobNotFoundError(id);

    const handlers: Record<string, () => Promise<void>> = {
      start: () => deps.jobManager.startJob(id, tenantId),
      pause: () => deps.jobManager.pauseJob(id, tenantId),
      resume: () => deps.jobManager.resumeJob(id, tenantId),
      cancel: () => deps.jobManager.cancelJob(id, tenantId),
      reconcile: () => deps.jobManager.triggerReconciliation(id, tenantId),
    };

    await handlers[action]();

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: `job.${action === 'cancel' ? 'cancelled' : action + 'ed'}`,
        resourceType: 'job',
        resourceId: id,
      });
    }

    return c.json({ data: { id, action, message: `Job ${action} successful` } });
  });

  router.openapi(deleteJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const job = await deps.jobRepo.findById(id, tenantId);
    if (!job) throw new JobNotFoundError(id);

    await deps.jobRepo.deleteWithData(id, tenantId);

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.deleted',
        resourceType: 'job',
        resourceId: id,
      });
    }

    return c.body(null, 204);
  });

  // Legacy POST aliases
  router.openapi(startJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    await deps.jobManager.startJob(id, tenantId);
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.started',
        resourceType: 'job',
        resourceId: id,
      });
    }
    return c.json({ data: { id, message: 'Job started' } });
  });
  router.openapi(pauseJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    await deps.jobManager.pauseJob(id, tenantId);
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.paused',
        resourceType: 'job',
        resourceId: id,
      });
    }
    return c.json({ data: { id, message: 'Job paused' } });
  });
  router.openapi(resumeJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    await deps.jobManager.resumeJob(id, tenantId);
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.resumed',
        resourceType: 'job',
        resourceId: id,
      });
    }
    return c.json({ data: { id, message: 'Job resumed' } });
  });
  router.openapi(cancelJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    await deps.jobManager.cancelJob(id, tenantId);
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.cancelled',
        resourceType: 'job',
        resourceId: id,
      });
    }
    return c.json({ data: { id, message: 'Job cancelled' } });
  });
  router.openapi(reconcileJobRoute, async (c) => {
    const { id } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    await deps.jobManager.triggerReconciliation(id, tenantId);
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'job.reconciled',
        resourceType: 'job',
        resourceId: id,
      });
    }
    return c.json({ data: { id, message: 'Reconciliation triggered' } });
  });

  return router;
}
