import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { AuthResult } from '@spatula/shared';

export function adminDlqRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const queueName = c.req.query('queue');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const entries = await deps.dlqRepo.findUnresolved({ queueName, tenantId, limit, offset });
    const total = await deps.dlqRepo.countUnresolved(queueName, tenantId);

    return c.json({ data: entries, pagination: { total, limit, offset } });
  });

  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);

    return c.json({ data: entry });
  });

  app.post('/:id/retry', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt)
      return c.json(
        { error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } },
        409,
      );

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

  app.post('/:id/discard', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo)
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'DLQ not configured' } }, 503);

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entry = await deps.dlqRepo.findById(c.req.param('id'), tenantId);
    if (!entry)
      return c.json({ error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } }, 404);
    if (entry.resolvedAt)
      return c.json(
        { error: { code: 'ALREADY_RESOLVED', message: 'Entry already resolved' } },
        409,
      );

    const resolved = await deps.dlqRepo.resolve(c.req.param('id'), 'discarded');
    return c.json({ data: resolved });
  });

  return app;
}
