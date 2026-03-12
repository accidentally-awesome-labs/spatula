import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { validateQuery } from '../middleware/validate.js';

const listActionsQuery = z.object({
  type: z.string().optional(),
  status: z
    .enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function actionRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — List actions
  router.get('/', validateQuery(listActionsQuery), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as z.infer<typeof listActionsQuery>;

    const actions = await deps.actionRepo.findByJob(jobId, tenantId, {
      type: query.type,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: actions });
  });

  // POST /approve-all — Batch approve (MUST be before /:actionId routes)
  router.post('/approve-all', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    const pending = await deps.actionRepo.findByJob(jobId, tenantId, {
      status: 'pending_review',
    });
    const ids = pending.map((a: { id: string }) => a.id);

    if (ids.length === 0) {
      return c.json({ data: [], message: 'No pending actions to approve' });
    }

    const updated = await deps.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
    return c.json({ data: updated });
  });

  // POST /:actionId/approve
  router.post('/:actionId/approve', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const actionId = c.req.param('actionId');

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'approved', reviewedBy);
    return c.json({ data: action });
  });

  // POST /:actionId/reject
  router.post('/:actionId/reject', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const actionId = c.req.param('actionId');

    const body = await c.req.json().catch(() => ({}));
    const reviewedBy = body?.reviewedBy;

    const action = await deps.actionRepo.updateStatus(actionId, tenantId, 'rejected', reviewedBy);
    return c.json({ data: action });
  });

  return router;
}
