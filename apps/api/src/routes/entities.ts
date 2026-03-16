import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { entityQuerySchema } from '../schemas/entity-query.js';
import type { EntityQueryParams } from '../schemas/entity-query.js';
import { validateQuery } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function entityRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', validateQuery(entityQuerySchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as EntityQueryParams;

    const [entities, total] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, {
        limit: query.limit,
        offset: query.offset,
        search: query.search,
      }),
      deps.entityRepo.countByJob(jobId, tenantId, {
        search: query.search,
      }),
    ]);

    return c.json({ data: entities, total });
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
