import { createRoute, z } from '@hono/zod-openapi';
import { InternalError } from '@accidentally-awesome-labs/spatula-shared';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const listWorkersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List active workers with health status',
  responses: {
    200: jsonContent(
      z.object({
        data: z.array(
          z.object({
            workerId: z.string(),
            queues: z.array(z.string()),
            pid: z.number(),
            uptime: z.number(),
            activeJobs: z.number(),
            lastBeat: z.string(),
            status: z.enum(['healthy', 'unhealthy']),
          }),
        ),
      }),
      'Worker list',
    ),
    500: jsonContent(errorResponseSchema, 'Redis unavailable'),
  },
});

export function adminWorkerRoutes() {
  const router = createOpenAPIRouter();

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(listWorkersRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.redis) throw new InternalError('Redis not configured for worker health monitoring');

    const workers: Array<Record<string, unknown>> = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await deps.redis.scan(
        cursor,
        'MATCH',
        'worker:heartbeat:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        const values = await deps.redis.mget(...keys);
        for (const value of values) {
          if (value) {
            try {
              workers.push({ ...JSON.parse(value), status: 'healthy' });
            } catch {
              /* skip */
            }
          }
        }
      }
    } while (cursor !== '0');

    return c.json({ data: workers });
  });

  return router;
}
