import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import { extractionResponseSchema, listResponse, jsonContent } from '../schemas/responses.js';

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
  responses: { 200: jsonContent(z.object({ data: z.array(extractionResponseSchema), total: z.number() }), 'Extractions with count') },
});

export function extractionRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

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

    return c.json({ data: extractions, total });
  });

  return router;
}
