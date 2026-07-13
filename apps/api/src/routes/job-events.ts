/**
 * SSE endpoint route definition — registered via @hono/zod-openapi createRoute
 * so it appears in /api/v1/openapi.json (used by the isolation suite
 * which enumerates routes from the served OpenAPI spec).
 *
 * Auth note: EventSource cannot send Authorization headers. The handler does its
 * own in-handler GETDEL token auth. The SSE path is on the auth-middleware
 * skip-list and is mounted BEFORE the requireScope('jobs:read') guard.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';
import { createSseHandler } from '../sse/handler.js';
import type { AppDeps } from '../types.js';

// Route is registered directly on the main OpenAPIHono app (not a sub-router),
// so the path must be the FULL path. The OpenAPI spec server base is /api/v1,
// meaning this appears as /jobs/{id}/events in the spec (server-relative).
// The full URL is GET /api/v1/jobs/{id}/events.
export const jobEventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/jobs/{id}/events',
  tags: ['Jobs'],
  operationId: 'streamJobEvents',
  summary: 'Subscribe to live job events (Server-Sent Events)',
  description:
    'Open a persistent SSE connection to receive live events for a job. ' +
    'Requires a single-use stream token from POST /api/v1/ws-token (same token works for WebSocket). ' +
    'Supports Last-Event-ID reconnect with up to 500-event / 5-minute replay buffer.',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Job ID' }),
    }),
    query: z.object({
      token: z
        .string()
        .openapi({ description: 'Single-use stream token from POST /api/v1/ws-token' }),
      lastEventId: z.string().optional().openapi({
        description:
          'Resume from this stream id (alternative to Last-Event-ID header for environments that cannot set request headers)',
      }),
    }),
  },
  responses: {
    200: {
      description:
        'SSE event stream. Events carry `id:` (Redis stream id), optional `event:` field, and `data:` (JSON-serialised JobEvent). ' +
        'A synthetic `replay_truncated` event is emitted when Last-Event-ID predates the oldest buffered entry.',
      content: {
        'text/event-stream': {
          schema: z.string().openapi({ description: 'SSE event stream' }),
        },
      },
    },
    401: jsonContent(errorResponseSchema, 'Missing or invalid stream token'),
    404: jsonContent(errorResponseSchema, 'Job not found for this tenant'),
  },
});

export function jobEventsRoutes(deps: AppDeps) {
  const router = createOpenAPIRouter();

  router.openapi(jobEventsRoute, createSseHandler(deps) as any);

  return router;
}
