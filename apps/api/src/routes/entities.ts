import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import type { PaginationParams } from '../schemas/pagination.js';
import { validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function entityRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', validateQuery(paginationSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as PaginationParams;

    const entities = await deps.entityRepo.findByJob(jobId, tenantId, {
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: entities });
  });

  router.get('/:entityId', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const entityId = c.req.param('entityId');

    const entity = await deps.entityRepo.findById(entityId, tenantId);
    if (!entity) {
      throw new NotFoundError('Entity', entityId);
    }

    const sources = await deps.entitySourceRepo.findByEntity(entityId);

    return c.json({
      data: {
        ...entity,
        sources,
      },
    });
  });

  return router;
}
