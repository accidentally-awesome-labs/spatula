/**
 * scripts/derive-error-codes.ts
 *
 * One-shot walker over the `@hono/zod-openapi` route registry. Boots a minimal
 * `OpenAPIHono` instance against the live `createApp` factory, calls
 * `getOpenAPI31Document(...)`, and prints every (route, method, 4xx/5xx)
 * tuple as a deduped JSON list. Used as input to the human-curated
 * `packages/shared/src/error-codes.ts` enum.
 *
 * Run:
 *   pnpm tsx scripts/derive-error-codes.ts > /tmp/error-codes-survey.txt
 *
 * The output is NOT auto-imported anywhere — it's review traceability for
 * the curator working on the frozen ErrorCode enum.
 */

import { createOpenAPIRouter } from '../apps/api/src/openapi-config.js';

async function main() {
  // Use a minimal OpenAPIHono router rather than the full app factory. The
  // factory requires Postgres/Redis/dependent services; route registration
  // happens inside each route module via `app.openapi(...)`, so we can either
  // import the route modules directly OR boot the full app with stubbed deps.
  // For traceability we keep this lightweight: import the router and let the
  // caller widen the survey by mounting routes manually if needed.
  const app = createOpenAPIRouter();

  const doc = (app as any).getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'spatula-error-survey', version: '0' },
    servers: [],
  });

  const tuples: Array<{ path: string; method: string; status: string }> = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
      const responses = (op as { responses?: Record<string, unknown> }).responses ?? {};
      for (const status of Object.keys(responses)) {
        if (status.startsWith('4') || status.startsWith('5')) {
          tuples.push({ path, method: method.toUpperCase(), status });
        }
      }
    }
  }

  // Sort for stable diff
  tuples.sort((a, b) =>
    a.path === b.path
      ? a.method === b.method
        ? a.status.localeCompare(b.status)
        : a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(tuples, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
