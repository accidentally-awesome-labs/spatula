import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { entityQuerySchema } from '../schemas/entity-query.js';
import { paginationEnvelopeSchema } from '../schemas/pagination.js';
import {
  entityResponseSchema,
  entityListItemSchema,
  errorResponseSchema,
  dataResponse,
  jsonContent,
} from '../schemas/responses.js';
import { decodeCursor, encodeCursor, EntityNotFoundError } from '@spatula/shared';
import { applyDeprecationHeaders } from '../lib/deprecation-headers.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listEntitiesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Entities'],
  summary: 'List entities for a job',
  request: { params: jobIdParam, query: entityQuerySchema },
  responses: {
    200: jsonContent(
      z.object({ data: z.array(entityListItemSchema), pagination: paginationEnvelopeSchema }),
      'Entities with pagination',
    ),
  },
});

const getEntityRoute = createRoute({
  method: 'get',
  path: '/{entityId}',
  tags: ['Entities'],
  summary: 'Get entity with source details',
  request: {
    params: jobIdParam.extend({
      entityId: z.string().openapi({ param: { name: 'entityId', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(
      dataResponse(entityResponseSchema.extend({ sources: z.array(z.record(z.unknown())) })),
      'Entity with sources',
    ),
    404: jsonContent(errorResponseSchema, 'Entity not found'),
  },
});

export function entityRoutes() {
  const router = createOpenAPIRouter();

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(listEntitiesRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    // Cursor or since path (keyset-based)
    if (query.cursor || query.since) {
      const cursorId = query.cursor ? decodeCursor(query.cursor).id : undefined;
      const result = await deps.entityRepo.findByJobCursor(
        jobId,
        tenantId,
        query.limit,
        cursorId,
        query.since,
      );
      // total is the unfiltered job-level count (not filtered by cursor/since)
      const total = await deps.entityRepo.countByJob(jobId, tenantId);
      return c.json({
        data: result.entities,
        pagination: {
          total,
          limit: query.limit,
          hasMore: !!result.nextCursor,
          nextCursor: result.nextCursor ? encodeCursor({ id: result.nextCursor }) : undefined,
        },
      });
    }

    // Offset fallback (no cursor, no since) — DEPRECATED at v1, removal target v2.0.
    // Phase 16 plan 16-1: emit Deprecation / Sunset / Link headers (RFC 8594).
    const [entityList, total] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, {
        limit: query.limit,
        offset: query.offset,
        search: query.search,
      }),
      deps.entityRepo.countByJob(jobId, tenantId, { search: query.search }),
    ]);

    applyDeprecationHeaders(c);

    return c.json({
      data: entityList,
      pagination: {
        total,
        limit: query.limit,
        hasMore: query.offset + query.limit < total,
      },
    });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getEntityRoute, async (c) => {
    const { entityId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const entity = await deps.entityRepo.findById(entityId, tenantId);
    if (!entity) throw new EntityNotFoundError(entityId);

    const sources = await deps.entitySourceRepo.findByEntityWithUrls(entityId);
    return c.json({ data: { ...entity, sources } });
  });

  return router;
}
