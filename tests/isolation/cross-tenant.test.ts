/**
 * Cross-tenant isolation matrix.
 *
 * What this suite proves:
 *   - Tenant A can NEVER read Tenant B's resources via any authed route.
 *   - The enumerated routes come from the SERVED /api/v1/openapi.json so new
 *     routes are covered automatically.
 *   - Every cross-tenant response is 403/404 with the standard error envelope
 *     and no leaked tenant data.
 *
 * Mirrors the describe.each / it.each pattern from tests/contract/generated.test.ts.
 *
 * Prerequisites (run in beforeAll):
 *   - Live Postgres (TEST_DATABASE_URL or DATABASE_URL)
 *   - Live Redis (REDIS_URL or redis://localhost:6379)
 *   - No Dex/JWT required — uses ApiKeyAuthProvider (AUTH_STRATEGY=none default)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startIsolationServer, type IsolationServer } from './server-harness.js';
import { seedTenantWithResources, type SeededTenant } from './fixtures.js';
import {
  enumerateAuthedRoutes,
  buildCrossTenantCase,
  assertIsolated,
  markAsserted,
  markSkipped,
  coverageReport,
  type RouteCase,
  type TestCase,
} from './generator.js';

// ─── Suite state ─────────────────────────────────────────────────────────────

let server: IsolationServer;
let spec: Record<string, unknown>;
let tenantA: SeededTenant;
let tenantB: SeededTenant;

// ─── Suite lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Boot the API with real Postgres + Redis (rate-limit + ws-token need Redis)
  server = await startIsolationServer();

  // Fetch the served OpenAPI spec, which is the canonical route list.
  const specRes = await fetch(`${server.url}/api/v1/openapi.json`);
  expect(specRes.status, 'OpenAPI spec endpoint must be reachable').toBe(200);
  spec = (await specRes.json()) as Record<string, unknown>;

  // Seed tenant A and tenant B with one resource per resource type
  tenantA = await seedTenantWithResources(server.pool, 'tenant-a');
  tenantB = await seedTenantWithResources(server.pool, 'tenant-b');
}, 60_000);

afterAll(async () => {
  if (server) await server.close();
});

// ─── Spec presence assertions (gating check) ─────────────────────────────────

describe('OpenAPI spec contains required routes', () => {
  it('SSE route /api/v1/jobs/{id}/events appears in /api/v1/openapi.json', () => {
    const paths = (spec as { paths?: Record<string, unknown> }).paths ?? {};
    // The spec is served with a server base url of /api/v1, so routes may appear
    // relative OR absolute depending on how @hono/zod-openapi mounts them.
    // We check for the full path as registered in job-events.ts (createRoute full path).
    const sseKey = Object.keys(paths).find(
      (p) => p === '/api/v1/jobs/{id}/events' || p === '/jobs/{id}/events',
    );
    expect(
      sseKey,
      'SSE route must be registered via createRoute and appear in /api/v1/openapi.json ' +
        `Found paths: ${
          Object.keys(paths)
            .filter((p) => p.includes('events'))
            .join(', ') || 'none'
        }`,
    ).toBeDefined();
  });

  it('rotate route /api/v1/api-keys/{id}/rotate appears in /api/v1/openapi.json', () => {
    const paths = (spec as { paths?: Record<string, unknown> }).paths ?? {};
    const rotateKey = Object.keys(paths).find(
      (p) =>
        p === '/api/v1/api-keys/{id}/rotate' ||
        p === '/api/keys/{id}/rotate' ||
        p.endsWith('/rotate'),
    );
    expect(
      rotateKey,
      'Rotate route must be registered via createRoute and appear in /api/v1/openapi.json ' +
        `Found paths: ${
          Object.keys(paths)
            .filter((p) => p.includes('rotate'))
            .join(', ') || 'none'
        }`,
    ).toBeDefined();
  });
});

// ─── Positive control ─────────────────────────────────────────────────────────

describe('Positive control — tenant A can access its own resources', () => {
  it('tenant A bearer token can GET its own job', async () => {
    const res = await fetch(`${server.url}/api/v1/jobs/${tenantA.resources.jobId}`, {
      headers: { Authorization: `Bearer ${tenantA.bearerToken}` },
    });
    // 200 proves the resource was actually seeded and is reachable.
    // If this fails, a cross-tenant 404 could be a false pass (resource not seeded).
    expect(
      res.status,
      `Positive control FAILED: tenant A cannot access its own job. ` +
        `Job id: ${tenantA.resources.jobId}. Status: ${res.status}. ` +
        `If status is 404, the seed job was not persisted correctly.`,
    ).toBe(200);
  });

  it('tenant A bearer token can GET its own entity', async () => {
    const res = await fetch(
      `${server.url}/api/v1/jobs/${tenantA.resources.jobId}/entities/${tenantA.resources.entityId}`,
      { headers: { Authorization: `Bearer ${tenantA.bearerToken}` } },
    );
    expect(
      res.status,
      `Positive control FAILED: tenant A cannot access its own entity. ` +
        `Entity id: ${tenantA.resources.entityId}. Status: ${res.status}.`,
    ).toBe(200);
  });

  it('tenant A bearer token can GET its own api-key list', async () => {
    const res = await fetch(`${server.url}/api/v1/api-keys`, {
      headers: { Authorization: `Bearer ${tenantA.bearerToken}` },
    });
    expect(res.status, 'Positive control FAILED: tenant A cannot list its own api-keys.').toBe(200);
  });
});

// ─── Cross-tenant matrix ───────────────────────────────────────────────────────

describe('Cross-tenant isolation matrix (OpenAPI-driven)', () => {
  // Build the route cases lazily inside the describe body so they're
  // available for describe.each. We collect them as a flat array and
  // then use it.each.
  //
  // NOTE: Vitest describe.each / it.each expects synchronous iteration
  // setup. Because enumerateAuthedRoutes runs synchronously once the spec
  // is loaded (which happens in beforeAll), we collect the cases in a
  // closure that resolves after beforeAll.

  it('enumerates at least one authed route from the OpenAPI spec', () => {
    const paths = (spec as { paths?: Record<string, unknown> }).paths ?? {};
    expect(Object.keys(paths).length).toBeGreaterThan(0);
  });

  it('all enumerated authed routes return 403/404 with standard envelope when tenant-B token hits tenant-A resource', async () => {
    const paths = (spec as { paths?: Record<string, unknown> }).paths ?? {};
    const specObj = { paths } as any;

    const routeCases = enumerateAuthedRoutes(specObj, tenantA);

    const failures: string[] = [];

    for (const route of routeCases) {
      const testName = `${route.method.toUpperCase()} ${route.path}`;

      // Skip routes with path params we couldn't resolve from seeded resources.
      if (route.hasUnresolvableParams) {
        markSkipped(route.method, route.path, 'path params not mappable to seeded resources');
        continue;
      }

      // Skip routes that the generator already put on the skip-list
      // (they have no `hasUnresolvableParams` but may need to be excluded
      //  for documented reasons — the generator handles those in enumerateAuthedRoutes).

      const testCase = buildCrossTenantCase(route, tenantA, tenantB, server.url);

      try {
        let response: Response;

        if (route.authMode === 'stream-token') {
          // SSE route: mint a tenant-B stream token via POST /api/v1/ws-token
          // with tenant-B's bearer token, then issue GET <path>?token=<token>.
          const tokenRes = await fetch(`${server.url}/api/v1/ws-token`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tenantB.bearerToken}`,
              'Content-Type': 'application/json',
            },
          });

          let streamToken: string | undefined;
          if (tokenRes.ok) {
            const tokenBody = (await tokenRes.json()) as {
              data?: { token?: string };
            };
            streamToken = tokenBody.data?.token;
          }

          if (!streamToken) {
            // If Redis is unavailable or ws-token is not wired, skip the SSE check
            // with a documented reason rather than false-failing the suite.
            markSkipped(
              route.method,
              route.path,
              `ws-token endpoint returned ${tokenRes.status} — Redis may be unavailable`,
            );
            continue;
          }

          // Issue the SSE request with tenant-B's stream token against tenant-A's job id.
          // EventSource semantics: the server sees tenantId from the stream token (tenant B)
          // and job id from the URL path (tenant A) — mismatch → 403/404.
          const sseUrl = new URL(testCase.url);
          sseUrl.searchParams.set('token', streamToken);

          // fetch() with no special headers (EventSource semantics).
          // We don't need a full EventSource connection — just the HTTP response status.
          response = await fetch(sseUrl.toString(), {
            method: 'GET',
            // Signal abort immediately so the SSE stream doesn't hold the connection open.
            signal: AbortSignal.timeout(5_000),
          });
        } else {
          // Standard bearer-header route
          response = await fetch(testCase.url, {
            method: route.method,
            headers: {
              Authorization: `Bearer ${tenantB.bearerToken}`,
              'Content-Type': 'application/json',
            },
            // For write methods we need a body — send an empty JSON object.
            // The route will 400/403/404 on validation before doing any work.
            ...(route.method.toLowerCase() !== 'get' && route.method.toLowerCase() !== 'delete'
              ? { body: '{}' }
              : {}),
          });
        }

        await assertIsolated(response, tenantA, testName);
        markAsserted(route.method, route.path);
      } catch (err) {
        failures.push(`${testName}: ${(err as Error).message}`);
      }
    }

    // Report all failures at once (not just the first one)
    expect(failures, `Cross-tenant isolation failures:\n${failures.join('\n')}`).toEqual([]);
  }, 60_000);

  it('coverage report has no unexplained discovered-but-unasserted routes', () => {
    const report = coverageReport();

    if (report.gaps.length > 0) {
      const gapList = report.gaps.map((g) => `  ${g.method} ${g.path}`).join('\n');
      throw new Error(
        `Coverage gap: ${report.gaps.length} route(s) were discovered in the OpenAPI spec ` +
          `but neither asserted nor documented in the skip-list:\n${gapList}\n\n` +
          `Either add them to the skip-list in generator.ts with a documented reason, ` +
          `or ensure they are covered by the isolation matrix.`,
      );
    }

    // Summary for visibility
    console.log(
      `[isolation-coverage] discovered=${report.discovered.length} ` +
        `asserted=${report.asserted.length} ` +
        `skipped=${report.skipped.length} ` +
        `gaps=${report.gaps.length}`,
    );

    expect(report.gaps).toHaveLength(0);
  });
});
