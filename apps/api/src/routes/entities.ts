import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { entityQuerySchema } from '../schemas/entity-query.js';
import { entityResponseSchema, errorResponseSchema, dataResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listEntitiesRoute = createRoute({
  method: 'get', path: '/', tags: ['Entities'],
  summary: 'List entities for a job',
  request: { params: jobIdParam, query: entityQuerySchema },
  responses: {
    200: jsonContent(z.object({ data: z.array(entityResponseSchema), total: z.number() }), 'Entities with count'),
  },
});

const getEntityRoute = createRoute({
  method: 'get', path: '/{entityId}', tags: ['Entities'],
  summary: 'Get entity with source details',
  request: {
    params: jobIdParam.extend({
      entityId: z.string().openapi({ param: { name: 'entityId', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(entityResponseSchema.extend({ sources: z.array(z.record(z.unknown())) })), 'Entity with sources'),
    404: jsonContent(errorResponseSchema, 'Entity not found'),
  },
});

export function entityRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listEntitiesRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const [entities, total] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, {
        limit: query.limit,
        offset: query.offset,
        search: query.search,
      }),
      deps.entityRepo.countByJob(jobId, tenantId, { search: query.search }),
    ]);

    return c.json({ data: entities, total });
  });

  router.openapi(getEntityRoute, async (c) => {
    const { entityId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const entity = await deps.entityRepo.findById(entityId, tenantId);
    if (!entity) throw new NotFoundError('Entity', entityId);

    const sources = await deps.entitySourceRepo.findByEntityWithUrls(entityId);
    return c.json({ data: { ...entity, sources } });
  });

  return router;
}
