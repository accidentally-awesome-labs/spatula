import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import {
  InternalQueueError,
  JobInvalidStateError,
  SpatulaError,
  ErrorCode,
} from '@accidentally-awesome-labs/spatula-shared';
import type { AuthResult } from '@accidentally-awesome-labs/spatula-shared';

/**
 * DLQ entries are an admin-only concept tied to a queued job. There is no
 * dedicated `DLQ.*` domain in the v1 frozen enum (the enum is additive-only;
 * adding `DLQ.NOT_FOUND` mid-sweep would expand v1 surface unnecessarily).
 * For now we re-use `ErrorCode.JOB_NOT_FOUND` (also 404) and carry the
 * `dlqEntryId` in `details` so callers can identify the missing resource.
 */
function dlqNotFound(entryId: string): SpatulaError {
  return new SpatulaError(`DLQ entry ${entryId} not found`, ErrorCode.JOB_NOT_FOUND, {
    context: { resource: 'dlq_entry', dlqEntryId: entryId },
  });
}

export function adminDlqRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) throw new InternalQueueError('DLQ not configured');

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
    if (!deps.dlqRepo) throw new InternalQueueError('DLQ not configured');

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entryId = c.req.param('id');
    const entry = await deps.dlqRepo.findById(entryId, tenantId);
    if (!entry) throw dlqNotFound(entryId);

    return c.json({ data: entry });
  });

  app.post('/:id/retry', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) throw new InternalQueueError('DLQ not configured');

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entryId = c.req.param('id');
    const entry = await deps.dlqRepo.findById(entryId, tenantId);
    if (!entry) throw dlqNotFound(entryId);
    if (entry.resolvedAt)
      throw new JobInvalidStateError('DLQ entry already resolved', {
        context: { dlqEntryId: entryId, resolvedAt: entry.resolvedAt },
      });

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

    const resolved = await deps.dlqRepo.resolve(entryId, 'retried');
    return c.json({ data: resolved });
  });

  app.post('/:id/discard', async (c) => {
    const deps = c.get('deps');
    if (!deps.dlqRepo) throw new InternalQueueError('DLQ not configured');

    const auth = c.get('auth') as AuthResult | undefined;
    const isAdmin = auth?.scopes.includes('admin') ?? false;
    const tenantId = isAdmin ? undefined : c.get('tenantId');

    const entryId = c.req.param('id');
    const entry = await deps.dlqRepo.findById(entryId, tenantId);
    if (!entry) throw dlqNotFound(entryId);
    if (entry.resolvedAt)
      throw new JobInvalidStateError('DLQ entry already resolved', {
        context: { dlqEntryId: entryId, resolvedAt: entry.resolvedAt },
      });

    const resolved = await deps.dlqRepo.resolve(entryId, 'discarded');
    return c.json({ data: resolved });
  });

  return app;
}
