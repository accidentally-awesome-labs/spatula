import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { paginationSchema, paginationEnvelopeSchema } from '../schemas/pagination.js';
import { extractionResponseSchema, listResponse, jsonContent } from '../schemas/responses.js';
import { decodeCursor, encodeCursor } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const listExtractionsQuery = paginationSchema.extend({
  schemaVersion: z.coerce.number().int().min(1).optional(),
});

const listRoute = createRoute({
  method: 'get', path: '/', tags: ['Extractions'],
  summary: 'List extractions for a job',
  request: { params: jobIdParam, query: listExtractionsQuery },
  responses: {
    200: jsonContent(
      z.object({ data: z.array(extractionResponseSchema), pagination: paginationEnvelopeSchema }),
      'Extractions with pagination',
    ),
  },
});

export function extractionRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    // Cursor or since path (keyset-based)
    if (query.cursor || query.since) {
      const cursorId = query.cursor ? decodeCursor(query.cursor).id : undefined;
      const result = await deps.extractionRepo.findByJobCursor(jobId, tenantId, query.limit, cursorId, query.since);
      // total is the unfiltered job-level count (not filtered by cursor/since)
      const total = await deps.extractionRepo.countByJob(jobId, tenantId, { schemaVersion: query.schemaVersion });
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

    // Offset fallback (no cursor, no since)
    const [extractions, total] = await Promise.all([
      deps.extractionRepo.findByJob(jobId, tenantId, {
        schemaVersion: query.schemaVersion,
        limit: query.limit,
        offset: query.offset,
      }),
      deps.extractionRepo.countByJob(jobId, tenantId, {
        schemaVersion: query.schemaVersion,
      }),
    ]);

    return c.json({
      data: extractions,
      pagination: {
        total,
        limit: query.limit,
        hasMore: query.offset + query.limit < total,
      },
    });
  });

  return router;
}
