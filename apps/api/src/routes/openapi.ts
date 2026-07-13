/**
 * Live OpenAPI 3.1 spec endpoint.
 *
 * `GET /api/v1/openapi.json` serves the boot-cached OpenAPI document built
 * once from the live `OpenAPIHono` registry. Two consecutive requests
 * return byte-identical bodies, enabling downstream CDN caching.
 *
 * The route is registered as a sub-router so that calling
 * `openapiRoute(rootApp)` defers reading the cached spec until first request,
 * AFTER all other routes have registered on the root app. This avoids
 * order-of-registration races that would freeze a partial spec.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCachedOpenAPISpec } from '../openapi-config.js';
import type { AppEnv } from '../types.js';

export function openapiRoute(rootApp: OpenAPIHono<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/openapi.json',
      tags: ['system'],
      summary: 'Live OpenAPI 3.1 spec for this server (boot-cached)',
      description:
        'Single source-of-truth for the v1 REST contract. Byte-identical across requests in a process lifetime.',
      responses: {
        200: {
          description: 'OpenAPI 3.1 document',
          content: { 'application/json': { schema: z.record(z.unknown()) } },
        },
      },
    }),
    // Hono's @hono/zod-openapi infers the handler response type as
    // `TypedResponse<never, 200, 'json'>` when the response schema is
    // `z.record(z.unknown())` — so the returned `c.json` value cannot
    // satisfy the strict handler signature. The runtime is safe; the cast
    // is the documented escape hatch for this corner of the typing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((c: Context<AppEnv>) => c.json(getCachedOpenAPISpec(rootApp), 200)) as any,
  );
  return app;
}
