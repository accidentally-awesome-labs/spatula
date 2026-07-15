import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { InternalError } from '@accidentally-awesome-labs/spatula-shared';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const WS_TOKEN_TTL = 60;

const createWsTokenRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['WebSocket'],
  // Token can be used by WebSocket-style and SSE event consumers.
  // operationId, path, request/response schema, and 60s TTL are UNCHANGED.
  summary: 'Create a single-use stream token (WebSocket or SSE)',
  description:
    'Issues a short-lived (60 s) single-use token that authenticates either ' +
    'the WebSocket upgrade at GET /ws/jobs/:id/progress or the SSE stream at ' +
    'GET /api/v1/jobs/:id/events?token=. The token is consumed atomically via ' +
    'GETDEL on first use.',
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

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(createWsTokenRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');

    if (!deps.redis) {
      throw new InternalError('Redis not configured');
    }

    const token = randomBytes(32).toString('base64url');
    const key = `ws-token:${token}`;
    const value = JSON.stringify({ tenantId, createdAt: new Date().toISOString() });

    await deps.redis.set(key, value, 'EX', WS_TOKEN_TTL);

    return c.json({ data: { token, expiresIn: WS_TOKEN_TTL } });
  });

  return router;
}
