import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminJobRoutes() {
  const app = new Hono<AppEnv>();

  // GET / — list jobs across all tenants with pagination
  app.get('/', async (c) => {
    const deps = c.get('deps');
    const status = c.req.query('status') as any;
    const tenantId = c.req.query('tenantId');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const [jobList, total] = await Promise.all([
      deps.jobRepo.findAll({ status, tenantId, limit, offset }),
      deps.jobRepo.countAll({ status, tenantId }),
    ]);

    return c.json({
      data: jobList.map((j: any) => ({
        id: j.id,
        tenantId: j.tenantId,
        name: j.name,
        status: j.status,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
      pagination: { total, limit, offset },
    });
  });

  // POST /:id/force-cancel — force-cancel a stuck job
  app.post('/:id/force-cancel', async (c) => {
    const deps = c.get('deps');
    const jobId = c.req.param('id');

    const job = await deps.jobRepo.forceCancel(jobId);
    if (!job) return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);

    // Drain BullMQ jobs for this job if queues are available
    if (deps.queues) {
      for (const queue of [deps.queues.crawl, deps.queues.extract, deps.queues.schemaEvolution, deps.queues.reconciliation, deps.queues.export]) {
        try {
          const waiting = await queue.getJobs(['waiting', 'delayed']);
          for (const queueJob of waiting) {
            if ((queueJob.data as any)?.jobId === jobId) {
              await queueJob.remove();
            }
          }
        } catch {
          // Best effort — queue may not be available
        }
      }
    }

    const auth = c.get('auth');
    deps.auditLogger?.log({
      tenantId: (job as any).tenantId,
      actorId: auth?.userId ?? 'system',
      actorType: 'user',
      action: 'admin.job.force_cancel',
      resourceType: 'job',
      resourceId: jobId,
    });

    return c.json({ data: job });
  });

  return app;
}
