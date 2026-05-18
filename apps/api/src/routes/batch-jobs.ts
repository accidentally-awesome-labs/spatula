import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { createLogger } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const logger = createLogger('batch-jobs');

const CANCELLABLE_STATUSES = new Set(['pending', 'queued', 'running', 'paused']);

const batchJobSchema = z.object({
  action: z.enum(['cancel', 'delete']),
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export function batchJobRoutes() {
  const router = new Hono<AppEnv>();

  router.post('/batch', async (c) => {
    const raw = await c.req.json();
    const parsed = batchJobSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid request',
            requestId: '',
          },
        },
        400,
      );
    }
    const { action, ids } = parsed.data;
    const tenantId = c.get('tenantId');
    const auth = c.get('auth');
    const deps = c.get('deps');

    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const job = await deps.jobRepo.findById(id, tenantId);
        if (!job) {
          failed.push({ id, error: 'Job not found' });
          continue;
        }

        if (action === 'cancel') {
          if (!CANCELLABLE_STATUSES.has(job.status)) {
            failed.push({ id, error: `Cannot cancel job with status '${job.status}'` });
            continue;
          }
          await deps.jobRepo.updateStatus(id, tenantId, 'cancelled');
        } else {
          // Cancel active/queued jobs before deleting to avoid orphaned BullMQ work
          if (CANCELLABLE_STATUSES.has(job.status)) {
            await deps.jobRepo.updateStatus(id, tenantId, 'cancelled');
          }
          await deps.jobRepo.deleteWithData(id, tenantId);
        }

        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: auth?.userId,
        actorType: 'user',
        action: `jobs.batch_${action}`,
        resourceType: 'job',
        resourceId: ids.join(','),
        metadata: { succeeded: succeeded.length, failed: failed.length },
      });
    }

    logger.info(
      { action, total: ids.length, succeeded: succeeded.length, failed: failed.length },
      'batch job operation complete',
    );
    return c.json({ data: { succeeded, failed } });
  });

  return router;
}
