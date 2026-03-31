import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { createLogger } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const logger = createLogger('batch-actions');

const batchActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export function batchActionRoutes() {
  const router = new Hono<AppEnv>();

  router.post('/batch', async (c) => {
    const raw = await c.req.json();
    const parsed = batchActionSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid request', requestId: '' } }, 400);
    }
    const { action, ids } = parsed.data;
    const tenantId = c.get('tenantId');
    const auth = c.get('auth');
    const deps = c.get('deps');
    const reviewedBy = auth?.userId;

    const status = action === 'approve' ? 'approved' : 'rejected';
    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const existing = await deps.actionRepo.findById(id, tenantId);
        if (!existing) {
          failed.push({ id, error: 'Action not found' });
          continue;
        }
        if (existing.status !== 'pending_review') {
          failed.push({ id, error: `Action is already ${existing.status}` });
          continue;
        }
        await deps.actionRepo.updateStatus(id, tenantId, status, reviewedBy);
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: reviewedBy,
        actorType: 'user',
        action: `actions.batch_${action}`,
        resourceType: 'action',
        resourceId: ids.join(','),
        metadata: { succeeded: succeeded.length, failed: failed.length },
      });
    }

    logger.info({ action, total: ids.length, succeeded: succeeded.length, failed: failed.length }, 'batch action complete');
    return c.json({ data: { succeeded, failed } });
  });

  return router;
}
