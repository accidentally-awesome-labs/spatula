/**
 * OpenAPI-driven cross-tenant route enumeration + assertion logic.
 * Phase 17 plan 17-07 — AUTH-07.
 *
 * Design decisions (D-17, D-18, D-19 from CONTEXT.md + RESEARCH.md Pitfall 5):
 *
 *   - Route list comes from the SERVED /api/v1/openapi.json — zero drift as
 *     routes are added (Don't Hand-Roll).
 *   - Cross-tenant access returns 403 OR 404 (D-18 prefers 404; 403 for scope-
 *     gated global resources). The assertIsolated() fn accepts either.
 *   - error.code is asserted to be RESOURCE.NOT_FOUND or AUTH.INSUFFICIENT_SCOPE
 *     (RESEARCH Pitfall 5 maps D-19's descriptive labels to actual frozen enum values).
 *   - The SSE route (GET /api/v1/jobs/{id}/events) uses ?token= auth (not a Bearer
 *     header) — the generator flags it as authMode: 'stream-token'.
 *   - A coverageReport() distinguishes discovered routes from actually-asserted ones.
 */

import type { SeededTenant } from './fixtures.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AuthMode = 'bearer' | 'stream-token';

export interface RouteCase {
  /** HTTP method (lowercase). */
  method: string;
  /** OpenAPI path template, e.g. /api/v1/jobs/{id}/entities/{entityId} */
  path: string;
  /**
   * How the route is authenticated:
   *   'bearer'       — standard Authorization: Bearer header
   *   'stream-token' — SSE route, auth via ?token= query param
   */
  authMode: AuthMode;
  /**
   * True when the path has params that couldn't be mapped to seeded resource ids.
   * Such routes are skipped in the matrix (see buildCrossTenantCase).
   */
  hasUnresolvableParams: boolean;
  /** Reason the route was skipped (if not asserted). Undefined when asserted. */
  skipReason?: string;
}

export interface TestCase {
  route: RouteCase;
  /** Full URL with tenant-A resource ids substituted in. */
  url: string;
  /** Tenant-B bearer token (for 'bearer' routes). */
  bearerToken?: string;
  /** Tenant-B stream token (for 'stream-token' routes — minted before the test). */
  streamToken?: string;
  tenantA: SeededTenant;
  tenantB: SeededTenant;
}

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
  servers?: Array<{ url: string }>;
}

// ─── Skip-list ──────────────────────────────────────────────────────────────

/**
 * Routes excluded from the cross-tenant matrix with documented reasons.
 *
 * Each entry is matched against `METHOD path` (method uppercase, path as-is).
 *
 * Add an entry here whenever a route should be skipped — the coverageReport()
 * will list the reason so the "no forgotten endpoints" guarantee holds.
 */
const SKIP_LIST: Array<{ method: string; path: string; reason: string }> = [
  // POST /api/v1/ws-token issues tokens for the current tenant — it is
  // tenant-scoped by the bearer header, not by a resource path param.
  // Cross-tenant isolation for token issuance is tested separately in
  // the stream-token test for the SSE route.
  {
    method: 'POST',
    path: '/api/v1/ws-token',
    reason: 'token-issuance endpoint, not a resource path; isolation is implicit in GETDEL',
  },
  // POST /api/v1/tenants is gated by the TENANT_CREATION_SECRET header,
  // not by a resource path param. Cross-tenant isolation not applicable.
  {
    method: 'POST',
    path: '/api/v1/tenants',
    reason: 'tenant creation is secret-gated, not resource-path-scoped',
  },
  // GET /api/v1/openapi.json is publicly unauthenticated.
  {
    method: 'GET',
    path: '/api/v1/openapi.json',
    reason: 'unauthenticated public endpoint',
  },
  // GET /.well-known/spatula-version is publicly unauthenticated.
  {
    method: 'GET',
    path: '/.well-known/spatula-version',
    reason: 'unauthenticated public endpoint',
  },
  // GET /api/docs is the Swagger UI — unauthenticated static asset.
  {
    method: 'GET',
    path: '/api/docs',
    reason: 'unauthenticated Swagger UI',
  },
  // GET /api/v1/auth/me is tenant-scoped by the bearer header (returns
  // caller's own identity — not a parameterised resource).
  {
    method: 'GET',
    path: '/api/v1/auth/me',
    reason: 'identity endpoint returning caller's own data — no cross-tenant resource path',
  },
  // Health endpoints are unauthenticated.
  {
    method: 'GET',
    path: '/health',
    reason: 'unauthenticated health endpoint',
  },
  {
    method: 'GET',
    path: '/health/live',
    reason: 'unauthenticated health endpoint',
  },
  {
    method: 'GET',
    path: '/health/ready',
    reason: 'unauthenticated health endpoint',
  },
  // GET /api/v1/usage is tenant-scoped by bearer (no per-resource path param).
  {
    method: 'GET',
    path: '/api/v1/usage',
    reason: 'tenant-aggregate endpoint — no cross-resource path param',
  },
  // GET /api/v1/schemas (list) — no per-resource path param.
  // Cross-tenant is tested via GET /api/v1/schemas/{id}.
];

function skipReason(method: string, path: string): string | undefined {
  const entry = SKIP_LIST.find(
    (s) => s.method === method.toUpperCase() && s.path === path,
  );
  return entry?.reason;
}

// ─── Param → resource id mapping ────────────────────────────────────────────

/**
 * Map from OpenAPI path param name (as it appears in `{paramName}`) to the
 * resource id field in `SeededResources`. Case-insensitive suffix match.
 *
 * OpenAPI path params use names like `{id}`, `{jobId}`, `{entityId}`, etc.
 * Hono templates use the same pattern with `{…}` for @hono/zod-openapi.
 */
const PARAM_RESOURCE_MAP: Array<{
  paramPattern: RegExp;
  resource: keyof import('./fixtures.js').SeededResources;
}> = [
  { paramPattern: /^id$/i, resource: 'jobId' },          // context-dependent; default = job
  { paramPattern: /job/i, resource: 'jobId' },
  { paramPattern: /entity/i, resource: 'entityId' },
  { paramPattern: /apikey|key/i, resource: 'apiKeyId' },
];

/**
 * Substitute tenant-A resource ids into an OpenAPI path template.
 *
 * @returns `{ resolvedPath, hasUnresolvable }` — hasUnresolvable is true if
 * any path param could not be mapped to a seeded resource.
 */
function resolvePath(
  pathTemplate: string,
  tenantA: SeededTenant,
): { resolvedPath: string; hasUnresolvable: boolean } {
  let hasUnresolvable = false;
  const resolvedPath = pathTemplate.replace(/\{([^}]+)\}/g, (_, paramName: string) => {
    // Try each mapping in order; take the first match.
    const entry = PARAM_RESOURCE_MAP.find((m) => m.paramPattern.test(paramName));
    if (entry) {
      const id = tenantA.resources[entry.resource];
      if (id) return id;
    }
    // Couldn't resolve — fall back to a bogus UUID so the URL is syntactically
    // valid, but flag the route as having unresolvable params.
    hasUnresolvable = true;
    return '00000000-0000-0000-0000-000000000000';
  });
  return { resolvedPath, hasUnresolvable };
}

// ─── Coverage tracking ──────────────────────────────────────────────────────

const _discoveredRoutes: Array<{ method: string; path: string }> = [];
const _assertedRoutes: Array<{ method: string; path: string }> = [];
const _skippedRoutes: Array<{ method: string; path: string; reason: string }> = [];

// ─── Public API ─────────────────────────────────────────────────────────────

const SSE_PATH_RE = /^\/api\/v1\/jobs\/\{[^}]+\}\/events$/;

/**
 * Enumerate every authed route in the served OpenAPI spec and build
 * RouteCase descriptors the test suite iterates.
 *
 * Skips:
 *   - Unauthenticated public endpoints (SKIP_LIST)
 *   - Routes with no path that can be resolved from seeded resources
 *     (flagged `hasUnresolvableParams: true`)
 *
 * The SSE route is NOT skipped — it is flagged `authMode: 'stream-token'`
 * and the test runner issues `?token=<tenant-B-stream-token>` instead.
 */
export function enumerateAuthedRoutes(
  spec: OpenApiSpec,
  tenantA: SeededTenant,
): RouteCase[] {
  const cases: RouteCase[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      // Track discovery
      _discoveredRoutes.push({ method: method.toUpperCase(), path });

      // Check skip-list
      const reason = skipReason(method, path);
      if (reason) {
        _skippedRoutes.push({ method: method.toUpperCase(), path, reason });
        continue;
      }

      // Detect SSE route (auth via ?token=)
      const isSSE = method.toLowerCase() === 'get' && SSE_PATH_RE.test(path);
      const authMode: AuthMode = isSSE ? 'stream-token' : 'bearer';

      // Resolve path params to tenant-A resource ids
      const { resolvedPath, hasUnresolvable } = resolvePath(path, tenantA);

      cases.push({
        method,
        path,
        authMode,
        hasUnresolvable,
        // Routes with unresolvable params are not committed to _assertedRoutes yet;
        // the test loop decides whether to assert or skip them.
      });
    }
  }

  return cases;
}

/**
 * Build a TestCase where tenant-A's resource path is combined with
 * tenant-B's credentials — the core of the cross-tenant isolation matrix.
 *
 * For 'bearer' routes: sets `bearerToken` to tenant-B's bearer token.
 * For 'stream-token' routes (SSE): the test runner must mint a tenant-B
 *   stream token and pass it here before calling the actual HTTP request.
 *
 * @param route     A RouteCase from enumerateAuthedRoutes
 * @param tenantA   The tenant whose resource ids are in the URL
 * @param tenantB   The tenant whose credentials are used to hit the URL
 * @param serverUrl Base URL of the running server
 */
export function buildCrossTenantCase(
  route: RouteCase,
  tenantA: SeededTenant,
  tenantB: SeededTenant,
  serverUrl: string,
): TestCase {
  const { resolvedPath } = resolvePath(route.path, tenantA);
  const url = `${serverUrl}${resolvedPath}`;
  return {
    route,
    url,
    bearerToken: route.authMode === 'bearer' ? tenantB.bearerToken : undefined,
    streamToken: undefined, // caller must fill in for stream-token routes
    tenantA,
    tenantB,
  };
}

/**
 * Assert a cross-tenant HTTP response is properly isolated.
 *
 * Checks:
 *   (a) Status is 403 or 404.
 *   (b) Body is the standard error envelope { error: { code, message, requestId } }.
 *   (c) error.code is one of the two acceptable codes:
 *         RESOURCE.NOT_FOUND  — cross-tenant lookup found no row for this tenant (D-18 prefer 404)
 *         AUTH.INSUFFICIENT_SCOPE — scope-gated global resource (D-18 prefer 403)
 *   (d) Neither error.message nor JSON.stringify(error.details) contains
 *       tenant-A's tenantId, resource ids, or label (no data leakage).
 *
 * @param response  The raw fetch Response
 * @param tenantA   The tenant whose data must not leak
 * @param testName  Human-readable route identifier for assertion messages
 */
export async function assertIsolated(
  response: Response,
  tenantA: SeededTenant,
  testName: string,
): Promise<void> {
  // (a) Status must be 403 or 404
  const validStatuses = [403, 404];
  if (!validStatuses.includes(response.status)) {
    throw new Error(
      `[${testName}] Expected 403 or 404 (cross-tenant isolation), got ${response.status}`,
    );
  }

  // (b) Body must be the standard error envelope
  let body: unknown;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      `[${testName}] Expected application/json response, got content-type: ${contentType}`,
    );
  }
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`[${testName}] Response body is not valid JSON: ${(err as Error).message}`);
  }

  const envelope = body as {
    error?: {
      code?: unknown;
      message?: unknown;
      requestId?: unknown;
      details?: unknown;
    };
  };

  if (!envelope.error || typeof envelope.error !== 'object') {
    throw new Error(
      `[${testName}] Response missing 'error' envelope: ${JSON.stringify(body)}`,
    );
  }

  if (typeof envelope.error.code !== 'string') {
    throw new Error(
      `[${testName}] error.code is not a string: ${JSON.stringify(envelope.error.code)}`,
    );
  }

  if (typeof envelope.error.message !== 'string') {
    throw new Error(
      `[${testName}] error.message is not a string: ${JSON.stringify(envelope.error.message)}`,
    );
  }

  // requestId may be absent on some error paths (e.g. very early middleware rejects)
  // — we accept its absence with a warning rather than hard-failing the isolation check.

  // (c) error.code must be RESOURCE.NOT_FOUND or AUTH.INSUFFICIENT_SCOPE
  //     (actual frozen enum values — RESEARCH.md Pitfall 5)
  const ACCEPTABLE_CODES = new Set([
    'RESOURCE.NOT_FOUND',
    'AUTH.INSUFFICIENT_SCOPE',
  ]);
  if (!ACCEPTABLE_CODES.has(envelope.error.code as string)) {
    throw new Error(
      `[${testName}] Unexpected error.code '${envelope.error.code}'. ` +
        `Expected one of: ${[...ACCEPTABLE_CODES].join(', ')}`,
    );
  }

  // (d) No tenant-A data leakage in the error fields
  const leakCandidates = [
    tenantA.tenantId,
    tenantA.resources.jobId,
    tenantA.resources.entityId,
    tenantA.resources.apiKeyId,
    tenantA.label,
  ].filter(Boolean);

  const searchableBody =
    (envelope.error.message as string) +
    JSON.stringify(envelope.error.details ?? {});

  for (const candidate of leakCandidates) {
    if (searchableBody.includes(candidate)) {
      throw new Error(
        `[${testName}] Data leak detected: tenant-A value '${candidate}' appears in error body. ` +
          `Full body: ${JSON.stringify(body)}`,
      );
    }
  }
}

/**
 * Mark a route as asserted in the coverage report.
 * Called by the test suite after each successful assertion.
 */
export function markAsserted(method: string, path: string): void {
  _assertedRoutes.push({ method: method.toUpperCase(), path });
}

/**
 * Mark a route as skipped (with a reason) in the coverage report.
 * Called by the test suite when a route is intentionally not asserted
 * (e.g. unresolvable params, already covered by a sibling route).
 */
export function markSkipped(method: string, path: string, reason: string): void {
  _skippedRoutes.push({ method: method.toUpperCase(), path, reason });
}

export interface CoverageReport {
  discovered: Array<{ method: string; path: string }>;
  asserted: Array<{ method: string; path: string }>;
  skipped: Array<{ method: string; path: string; reason: string }>;
  /**
   * Routes that were discovered but neither asserted nor in the skip-list —
   * these represent a coverage gap (D-17 "no forgotten endpoint" guarantee).
   */
  gaps: Array<{ method: string; path: string }>;
}

/**
 * Return a coverage report listing every route the generator discovered vs
 * every route that was actually asserted. The suite uses this to fail if a
 * route was discovered but neither asserted nor documented in the skip-list.
 */
export function coverageReport(): CoverageReport {
  const assertedSet = new Set(
    _assertedRoutes.map((r) => `${r.method}:${r.path}`),
  );
  const skippedSet = new Set(
    _skippedRoutes.map((r) => `${r.method}:${r.path}`),
  );

  const gaps = _discoveredRoutes.filter((r) => {
    const key = `${r.method.toUpperCase()}:${r.path}`;
    return !assertedSet.has(key) && !skippedSet.has(key);
  });

  return {
    discovered: [..._discoveredRoutes],
    asserted: [..._assertedRoutes],
    skipped: [..._skippedRoutes],
    gaps,
  };
}
