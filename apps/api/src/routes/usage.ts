import { createRoute, z } from '@hono/zod-openapi';
import { ValidationError } from '@spatula/shared';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

function parsePeriod(period: string): Date {
  const match = period.match(/^(\d+)d$/);
  if (!match) throw new ValidationError('Invalid period format. Use Nd (e.g., 30d).');
  const days = parseInt(match[1], 10);
  if (days < 1 || days > 365) throw new ValidationError('Period must be between 1d and 365d.');
  const since = new Date();
  since.setDate(since.getDate() - days);
  return since;
}

const getUsageRoute = createRoute({
  method: 'get', path: '/', tags: ['Usage'],
  summary: 'Get LLM usage for the authenticated tenant',
  request: {
    query: z.object({ period: z.string().default('30d').openapi({ example: '30d' }) }),
  },
  responses: {
    200: jsonContent(z.object({
      data: z.object({
        period: z.object({ start: z.string(), end: z.string() }),
        totalTokens: z.number(), totalCostUsd: z.number(),
        byModel: z.record(z.object({ tokens: z.number(), costUsd: z.number() })),
        byPurpose: z.record(z.object({ tokens: z.number(), costUsd: z.number() })),
        byJob: z.array(z.object({ jobId: z.string(), tokens: z.number(), costUsd: z.number() })),
      }),
    }), 'LLM usage aggregation'),
    400: jsonContent(errorResponseSchema, 'Invalid period'),
  },
});

export function usageRoutes() {
  const router = createOpenAPIRouter();
  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getUsageRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');
    const { period } = c.req.valid('query');
    if (!deps.llmUsageRepo) throw new Error('LLM usage tracking not configured');
    const since = parsePeriod(period);
    const aggregation = await deps.llmUsageRepo.aggregateByTenant(tenantId, since);
    return c.json({ data: { period: { start: since.toISOString(), end: new Date().toISOString() }, ...aggregation } });
  });
  return router;
}
