import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminDlqRoutes() {
  const app = new Hono<AppEnv>();

  // List unresolved DLQ entries (scoped to calling tenant)
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const tenantId = c.get('tenantId');
    const queueName = c.req.query('queue');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    // TODO(Phase 12 Workstream B): When admin auth is added, allow admins
    // to omit tenantId filter to see all tenants' DLQ entries.
    const entries = await deps.dlqRepo.findUnresolved({ queueName, tenantId, limit, offset });
    const total = await deps.dlqRepo.countUnresolved(queueName, tenantId);

    return c.json({ data: entries, pagination: { total, limit, offset } });
  });

  // Get single DLQ entry (scoped to calling tenant)
  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const tenantId = c.get('tenantId');
    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry) return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);

    return c.json({ data: entry });
  });

  // Retry a DLQ entry (re-enqueue to original queue + mark resolved)
  app.post('/:id/retry', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const tenantId = c.get('tenantId');
    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry) return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt) return c.json({ error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } }, 409);

    // Re-enqueue the original job data to the original queue
    if (deps.queues) {
      const queueMap: Record<string, any> = {
        'spatula.crawl': deps.queues.crawl,
        'spatula.schema-evolution': deps.queues.schemaEvolution,
        'spatula.reconciliation': deps.queues.reconciliation,
        'spatula.export': deps.queues.export,
      };
      const targetQueue = queueMap[entry.queueName];
      if (targetQueue) {
        await targetQueue.add(`dlq-retry:${entry.id}`, entry.payload);
      }
    }

    const resolved = await deps.dlqRepo.resolve(c.req.param('id'), 'retried');
    return c.json({ data: resolved });
  });

  // Discard a DLQ entry
  app.post('/:id/discard', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const tenantId = c.get('tenantId');
    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry) return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt) return c.json({ error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } }, 409);

    const resolved = await deps.dlqRepo.resolve(c.req.param('id'), 'discarded');

    return c.json({ data: resolved });
  });

  return app;
}
