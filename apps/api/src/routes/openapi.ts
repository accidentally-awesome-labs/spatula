/**
 * Phase 16 plan 16-3 (API-05): live OpenAPI 3.1 spec endpoint.
 *
 * `GET /api/v1/openapi.json` serves the boot-cached OpenAPI document built
 * once from the live `OpenAPIHono` registry (D-13). Two consecutive requests
 * return byte-identical bodies, enabling downstream CDN caching.
 *
 * The route is registered as a sub-router so that calling
 * `openapiRoute(rootApp)` defers reading the cached spec until first request,
 * AFTER all other routes have registered on the root app. This avoids
 * order-of-registration races that would freeze a partial spec.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
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
    (c) => {
      // Cast: the cached spec is a plain serializable JS object; Hono's
      // typed c.json wants a record matching the declared response schema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return c.json(getCachedOpenAPISpec(rootApp) as any, 200);
    },
  );
  return app;
}
