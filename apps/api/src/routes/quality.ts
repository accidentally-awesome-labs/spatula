import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent } from '../schemas/responses.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const getQualityRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Quality'],
  summary: 'Get quality score aggregation for a job',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(
      z.object({
        data: z.object({
          entityCount: z.number(),
          averageQuality: z.number(),
          distribution: z.object({
            excellent: z.number(),
            good: z.number(),
            fair: z.number(),
            poor: z.number(),
          }),
          fieldCompleteness: z.record(z.number()),
        }),
      }),
      'Quality aggregation',
    ),
  },
});

export function qualityRoutes() {
  const router = createOpenAPIRouter();
  router.openapi(getQualityRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const aggregation = await deps.entityRepo.getQualityAggregation(jobId, tenantId);
    return c.json({ data: aggregation });
  });
  return router;
}
