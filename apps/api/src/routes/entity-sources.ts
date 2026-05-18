import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { paginationSchema, paginationEnvelopeSchema } from '../schemas/pagination.js';
import { jsonContent } from '../schemas/responses.js';
import { decodeCursor, encodeCursor } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const entitySourceSchema = z.object({
  entityId: z.string().uuid(),
  extractionId: z.string().uuid(),
  matchConfidence: z.number(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['EntitySources'],
  summary: 'List entity-extraction linkages for a job',
  request: { params: jobIdParam, query: paginationSchema },
  responses: {
    200: jsonContent(
      z.object({ data: z.array(entitySourceSchema), pagination: paginationEnvelopeSchema }),
      'Entity sources with pagination',
    ),
  },
});

export function entitySourceRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    let cursor: { entityId: string; extractionId: string } | undefined;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (typeof decoded.sortValue !== 'string') {
        throw new Error('entity-sources cursor missing sortValue (extractionId)');
      }
      cursor = { entityId: decoded.id, extractionId: decoded.sortValue };
    }
    const result = await deps.entitySourceRepo.findByJobCursor(
      jobId,
      tenantId,
      query.limit,
      cursor,
      query.since,
    );
    const total = await deps.entitySourceRepo.countByJob(jobId, tenantId);

    return c.json({
      data: result.entities,
      pagination: {
        total,
        limit: query.limit,
        hasMore: !!result.nextCursor,
        nextCursor: result.nextCursor
          ? encodeCursor({
              id: result.nextCursor.entityId,
              sortValue: result.nextCursor.extractionId,
            })
          : undefined,
      },
    });
  });

  return router;
}
