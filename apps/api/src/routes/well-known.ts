/**
 * Phase 16 plan 16-3 (API-06): server version + compat support-matrix.
 *
 * `GET /.well-known/spatula-version` is a sibling of `/api/v1/*` — it lives at
 * the root path per the RFC 8615 `.well-known/` convention. SDK clients probe
 * this endpoint lazily on first request to verify major-version compatibility
 * BEFORE issuing real API calls; see `docs/compat-policy.md`.
 *
 * Payload shape is locked at v1:
 *   { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors[] } }
 *
 * For v1.0:
 *   - supportMatrix.minClientMajor = 1
 *   - supportMatrix.deprecatedClientMajors = []
 *
 * Values come from build-time env vars with permissive fallbacks so that
 * `pnpm dev` works locally without a CI build step:
 *   - SPATULA_VERSION (fallback '0.0.0-dev')
 *   - GIT_SHA (fallback 'unknown')
 *   - BUILD_AT (fallback `new Date().toISOString()` — boot timestamp)
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';

const versionResponse = z
  .object({
    version: z.string().openapi({ example: '1.0.0' }),
    gitSha: z.string().openapi({ example: 'a1b2c3d4' }),
    buildAt: z.string().datetime().openapi({ example: '2026-05-19T14:32:00.000Z' }),
    supportMatrix: z.object({
      minClientMajor: z.number().openapi({ example: 1 }),
      deprecatedClientMajors: z.array(z.number()).openapi({ example: [] }),
    }),
  })
  .openapi('SpatulaVersion');

export function wellKnownRoute() {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/.well-known/spatula-version',
      tags: ['system'],
      summary: 'Server version + compat support matrix',
      description:
        'Probed by SDK clients to verify major-version compatibility before issuing real requests. See docs/compat-policy.md.',
      responses: {
        200: {
          description: 'Server version metadata',
          content: { 'application/json': { schema: versionResponse } },
        },
      },
    }),
    (c) =>
      c.json(
        {
          version: process.env.SPATULA_VERSION ?? '0.0.0-dev',
          gitSha: process.env.GIT_SHA ?? 'unknown',
          buildAt: process.env.BUILD_AT ?? new Date().toISOString(),
          supportMatrix: { minClientMajor: 1, deprecatedClientMajors: [] as number[] },
        },
        200,
      ),
  );
  return app;
}
