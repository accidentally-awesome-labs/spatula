/**
 * Integration tests for GET /api/v1/jobs/:id/events (AUTH-01).
 *
 * Tests use createApp() with mocked deps (same pattern as tests/unit/app.test.ts).
 * Real SSE streaming requires a live server; these tests cover:
 *   - Route appears in /api/v1/openapi.json (plan 17-07 depends on this)
 *   - Response headers: content-type, x-accel-buffering, cache-control
 *   - Auth: missing token → 401; invalid token → 401; correct token → streaming
 *   - Cross-tenant: job not found for tenant → 404
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'job-abc-123';
const TOKEN = 'valid-stream-token-xyz';

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const mockRedis: any = {
    getdel: vi.fn().mockResolvedValue(JSON.stringify({ tenantId: TENANT_ID })),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    xrange: vi.fn().mockResolvedValue([]),
    xread: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1000-0'),
    quit: vi.fn().mockResolvedValue('OK'),
    subscribe: vi.fn(),
    publish: vi.fn(),
    on: vi.fn(),
    // rateLimitMiddleware uses redis.eval (Lua script) for rate limiting
    eval: vi.fn().mockResolvedValue([100, 50, Date.now() + 60000]),
  };

  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    redis: mockRedis,
    jobRepo: {
      findById: vi.fn().mockResolvedValue({ id: JOB_ID, tenantId: TENANT_ID, name: 'Test Job' }),
      create: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
    },
    schemaRepo: { findLatest: vi.fn().mockResolvedValue(null), findAllVersions: vi.fn().mockResolvedValue([]), findByVersion: vi.fn().mockResolvedValue(null) },
    extractionRepo: { findByJob: vi.fn().mockResolvedValue([]), countByJob: vi.fn().mockResolvedValue(0) },
    entityRepo: { findByJob: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue(null), countByJob: vi.fn().mockResolvedValue(0) },
    entitySourceRepo: { findByEntity: vi.fn().mockResolvedValue([]), findByEntityWithUrls: vi.fn().mockResolvedValue([]) },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
      countByJobAndStatus: vi.fn().mockResolvedValue(0),
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [], nextCursor: null }),
    },
    taskRepo: {} as any,
    exportRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), findByJob: vi.fn().mockResolvedValue([]), updateStatus: vi.fn() },
    contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() },
    exportQueue: { add: vi.fn() },
    jobManager: {
      createJob: vi.fn().mockResolvedValue(JOB_ID),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
      getJobStatus: vi.fn().mockResolvedValue('running'),
    },
    ...overrides,
  } as unknown as AppDeps;
}

describe('GET /api/v1/jobs/:id/events', { timeout: 15_000 }, () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
    // Reset ioredis constructor mock (used for dedicated SSE connection)
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  });

  // ── OpenAPI spec registration (AUTH-01 + plan 17-07 requirement) ──────────

  it('appears in GET /api/v1/openapi.json under paths', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = await res.json() as any;
    expect(spec.paths).toBeDefined();
    // The route is registered via createRoute with path '/jobs/{id}/events'
    // (relative to the /api/v1 server base). 17-07's isolation suite reads
    // the served spec and maps paths: spec.servers[0].url + path → full URL.
    // The full endpoint is GET /api/v1/jobs/{id}/events.
    // The route is registered on the main app with full path /api/v1/jobs/{id}/events,
    // so it appears as-is in the spec (no server-prefix stripping for direct app.openapi calls).
    // plan 17-07's isolation suite uses servers[0].url + path to construct full URLs.
    const specPath = spec.paths['/api/v1/jobs/{id}/events'];
    expect(specPath).toBeDefined();
    expect(specPath.get).toBeDefined();
    expect(specPath.get.operationId).toBe('streamJobEvents');
  });

  it('openapi spec declares text/event-stream content for 200 response', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/openapi.json');
    const spec = await res.json() as any;
    const responses = spec.paths['/api/v1/jobs/{id}/events'].get.responses;
    expect(responses['200'].content['text/event-stream']).toBeDefined();
  });

  it('openapi spec declares 401 and 404 error responses', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/openapi.json');
    const spec = await res.json() as any;
    const responses = spec.paths['/api/v1/jobs/{id}/events'].get.responses;
    expect(responses['401']).toBeDefined();
    expect(responses['404']).toBeDefined();
  });

  // ── Auth: missing token → 400/401 (schema validation catches it first) ──────
  // The @hono/zod-openapi defaultHook validates required query params.
  // ?token= is required; omitting it returns 400 (validation) before the handler
  // can return 401. Either 400 or 401 signals rejection — both are acceptable.

  it('rejects request when no token provided (400 from schema validation or 401 from handler)', async () => {
    const app = createApp(deps);
    // No ?token= — no Authorization header needed (path is on skip-list)
    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events`);
    // 400: query schema validation rejected it (token is required)
    // 401: handler ran and rejected it (both are valid auth-failure signals)
    expect([400, 401]).toContain(res.status);
  });

  // ── Auth: invalid/expired token → 401 ────────────────────────────────────

  it('returns 401 when token is invalid or expired (GETDEL returns null)', async () => {
    const depsWithBadRedis = createMockDeps({
      redis: {
        ...deps.redis,
        getdel: vi.fn().mockResolvedValue(null), // token not found
        set: vi.fn().mockResolvedValue('OK'),
      } as any,
    });
    const app = createApp(depsWithBadRedis);
    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=garbage`);
    expect(res.status).toBe(401);
  });

  // ── Auth bypass: SSE path must reach handler without Authorization header ──

  it('does not require Authorization header (EventSource cannot send it)', async () => {
    const app = createApp(deps);
    // With a valid token but no Authorization header — must NOT 401 at authMiddleware
    // (it would get past auth but may fail later if streamSSE is hard to mock here)
    // We assert auth middleware does NOT block it by checking the error is NOT 401
    // when token is valid. The actual 200 streaming response is verified separately.
    const mockRedis = deps.redis as any;
    mockRedis.getdel.mockResolvedValue(JSON.stringify({ tenantId: TENANT_ID }));
    const res = await app.request(
      `/api/v1/jobs/${JOB_ID}/events?token=${TOKEN}`,
      // No Authorization header
    );
    // Should reach handler (auth middleware skips it), not 401 from authMiddleware
    expect(res.status).not.toBe(401);
  });

  // ── SSE response headers ──────────────────────────────────────────────────

  it('sets X-Accel-Buffering: no and content-type: text/event-stream on valid request', async () => {
    const app = createApp(deps);
    const mockRedis = deps.redis as any;
    mockRedis.getdel.mockResolvedValue(JSON.stringify({ tenantId: TENANT_ID }));
    // xread returns null immediately (timeout) to let the stream settle
    mockRedis.xread = vi.fn().mockResolvedValue(null);

    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=${TOKEN}`);

    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });

  // ── Cross-tenant: job not found for tenant → 404 ─────────────────────────

  it('returns 404 when job does not belong to the token tenant', async () => {
    const depsNotFound = createMockDeps({
      jobRepo: {
        findById: vi.fn().mockResolvedValue(null), // job not found for this tenant
      } as any,
    });
    const app = createApp(depsNotFound);
    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=${TOKEN}`);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });

  // ── requireScope('jobs:read') must NOT intercept SSE path ─────────────────

  it('is NOT gated by requireScope jobs:read (mounted before scope guard)', async () => {
    // If the SSE route were behind requireScope, a request with a valid stream token
    // but no scope-bearing Authorization header would 401/403 from requireScope.
    // We verify it reaches the SSE handler by checking auth-middleware does not block.
    const mockRedis = deps.redis as any;
    mockRedis.getdel.mockResolvedValue(JSON.stringify({ tenantId: TENANT_ID }));
    const app = createApp(deps);
    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=${TOKEN}`);
    // Any response except 401/403 from scope guard means the handler was reached
    expect([401, 403].includes(res.status)).toBe(false);
  });
});
