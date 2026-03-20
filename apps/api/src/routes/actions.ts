import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { actionResponseSchema, listResponse, jsonContent } from '../schemas/responses.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listActionsQuery = z.object({
  type: z.string().optional(),
  status: z.enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back']).optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});

const reviewBodySchema = z.object({ reviewedBy: z.string().optional() });
const rejectBodySchema = z.object({ reviewedBy: z.string().optional(), reason: z.string().optional() });

const listRoute = createRoute({
  method: 'get', path: '/', tags: ['Actions'],
  summary: 'List actions for a job',
  request: { params: jobIdParam, query: listActionsQuery },
  responses: { 200: jsonContent(listResponse(actionResponseSchema), 'List of actions') },
});

const approveAllRoute = createRoute({
  method: 'post', path: '/approve-all', tags: ['Actions'],
  summary: 'Batch approve all pending actions',
  request: {
    params: jobIdParam,
    body: { content: { 'application/json': { schema: reviewBodySchema } } },
  },
  responses: { 200: jsonContent(listResponse(actionResponseSchema), 'Approved actions') },
});

const approveRoute = createRoute({
  method: 'post', path: '/{actionId}/approve', tags: ['Actions'],
  summary: 'Approve a single action',
  request: {
    params: jobIdParam.extend({
      actionId: z.string().openapi({ param: { name: 'actionId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: reviewBodySchema } } },
  },
  responses: { 200: jsonContent(z.object({ data: actionResponseSchema }), 'Approved action') },
});

const rejectRoute = createRoute({
  method: 'post', path: '/{actionId}/reject', tags: ['Actions'],
  summary: 'Reject an action',
  request: {
    params: jobIdParam.extend({
      actionId: z.string().openapi({ param: { name: 'actionId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: rejectBodySchema } } },
  },
  responses: { 200: jsonContent(z.object({ data: z.object({ id: z.string(), status: z.string() }) }), 'Rejected') },
});

export function actionRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const actions = await deps.actionRepo.findByJob(jobId, tenantId, {
      type: query.type, status: query.status, limit: query.limit, offset: query.offset,
    });
    return c.json({ data: actions });
  });

  router.openapi(approveAllRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');
    const reviewedBy = body?.reviewedBy;

    if (deps.reviewQueue) {
      const results = await deps.reviewQueue.approveAll(jobId, tenantId, reviewedBy);
      return c.json({ data: results });
    }

    const pending = await deps.actionRepo.findByJob(jobId, tenantId, { status: 'pending_review' });
    const ids = pending.map((a: { id: string }) => a.id);
    if (ids.length === 0) return c.json({ data: [] });

    const updated = await deps.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
    return c.json({ data: updated });
  });

  router.openapi(approveRoute, async (c) => {
    const { actionId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');

    if (deps.reviewQueue) {
      const action = await deps.reviewQueue.approve(actionId, tenantId, body?.reviewedBy);
      return c.json({ data: action });
    }

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'approved', body?.reviewedBy);
    return c.json({ data: action });
  });

  router.openapi(rejectRoute, async (c) => {
    const { actionId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const body = c.req.valid('json');

    if (deps.reviewQueue) {
      await deps.reviewQueue.reject(actionId, tenantId, body?.reviewedBy, body?.reason ?? '');
      return c.json({ data: { id: actionId, status: 'rejected' } });
    }

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'rejected', body?.reviewedBy);
    return c.json({ data: action });
  });

  return router;
}
