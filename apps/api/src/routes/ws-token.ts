import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const WS_TOKEN_TTL = 60;

const createWsTokenRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['WebSocket'],
  summary: 'Create a single-use WebSocket auth token',
  responses: {
    200: jsonContent(
      z.object({ data: z.object({ token: z.string(), expiresIn: z.number() }) }),
      'WebSocket token created',
    ),
    500: jsonContent(errorResponseSchema, 'Redis unavailable'),
  },
});

export function wsTokenRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createWsTokenRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');

    if (!deps.redis) {
      throw new Error('Redis not configured');
    }

    const token = randomBytes(32).toString('base64url');
    const key = `ws-token:${token}`;
    const value = JSON.stringify({ tenantId, createdAt: new Date().toISOString() });

    await deps.redis.set(key, value, 'EX', WS_TOKEN_TTL);

    return c.json({ data: { token, expiresIn: WS_TOKEN_TTL } });
  });

  return router;
}
