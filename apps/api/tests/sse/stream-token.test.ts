/**
 * Integration tests for the stream token lifecycle (AUTH-02).
 *
 * Covers:
 *   - POST /api/v1/ws-token returns { data: { token, expiresIn: 60 } }
 *   - Token is single-use: a second SSE connect with the same token is rejected
 *   - Expired/garbage token is rejected by SSE handler
 *   - Same token shape works conceptually for both WS and SSE (GETDEL pattern)
 *   - OpenAPI doc on ws-token summary contains 'SSE'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000002';
const JOB_ID = 'stream-token-job';

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const tokenStore = new Map<string, string>();

  const mockRedis: any = {
    // set: stores token (called by ws-token route)
    set: vi.fn().mockImplementation(async (key: string, value: string) => {
      tokenStore.set(key, value);
      return 'OK';
    }),
    // getdel: atomic consume (single-use)
    getdel: vi.fn().mockImplementation(async (key: string) => {
      const val = tokenStore.get(key) ?? null;
      if (val) tokenStore.delete(key); // consume
      return val;
    }),
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
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(null),
      findAllVersions: vi.fn().mockResolvedValue([]),
      findByVersion: vi.fn().mockResolvedValue(null),
    },
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([]),
      findByEntityWithUrls: vi.fn().mockResolvedValue([]),
    },
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
    exportRepo: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByJob: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
    },
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

describe('Stream token (AUTH-02)', { timeout: 15_000 }, () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  });

  // ── POST /api/v1/ws-token — token creation ────────────────────────────────

  it('POST /api/v1/ws-token returns token with 60s TTL', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/ws-token', {
      method: 'POST',
      headers: { 'x-tenant-id': TENANT_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.token).toBeDefined();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token.length).toBeGreaterThan(10);
    expect(body.data.expiresIn).toBe(60);
  });

  // ── Single-use: second SSE connect with same token is rejected ─────────────

  it('token is single-use — second SSE connect with same token is rejected', async () => {
    const app = createApp(deps);

    // Step 1: issue token via POST /api/v1/ws-token
    const tokenRes = await app.request('/api/v1/ws-token', {
      method: 'POST',
      headers: { 'x-tenant-id': TENANT_ID },
    });
    expect(tokenRes.status).toBe(200);
    const {
      data: { token },
    } = (await tokenRes.json()) as any;

    // Step 2: first SSE connect — consumes the token
    const firstRes = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=${token}`);
    // Should NOT be 401 from token (token was valid, just consumed)
    expect(firstRes.status).not.toBe(401);

    // Step 3: second SSE connect with the SAME token — must be rejected
    const secondRes = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=${token}`);
    expect(secondRes.status).toBe(401);
  });

  // ── Expired/garbage token → 401 ──────────────────────────────────────────

  it('garbage token is rejected with 401', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/jobs/${JOB_ID}/events?token=totally-fake-garbage`);
    expect(res.status).toBe(401);
  });

  // ── OpenAPI doc update: ws-token summary contains 'SSE' ──────────────────

  it('POST /api/v1/ws-token openapi summary mentions SSE', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/openapi.json');
    const spec = (await res.json()) as any;
    // ws-token route: sub-router mounted at /api/v1/ws-token with createRoute path '/'.
    // The OpenAPIHono registers this as /api/v1/ws-token in the paths map.
    const wsTokenPath =
      spec.paths['/api/v1/ws-token'] ?? // when registered on main app
      spec.paths['/ws-token']; // when server base strips /api/v1
    expect(wsTokenPath).toBeDefined();
    const summary: string = wsTokenPath.post?.summary ?? '';
    expect(summary.toLowerCase()).toContain('sse');
  });

  // ── Same GETDEL pattern for both WS and SSE ───────────────────────────────

  it('token stored at ws-token:{token} key (same namespace for WS and SSE)', async () => {
    const app = createApp(deps);

    // Issue a token
    const tokenRes = await app.request('/api/v1/ws-token', {
      method: 'POST',
      headers: { 'x-tenant-id': TENANT_ID },
    });
    const {
      data: { token },
    } = (await tokenRes.json()) as any;

    // The mock redis.set should have been called with ws-token:{token}
    const mockRedis = deps.redis as any;
    expect(mockRedis.set).toHaveBeenCalledWith(
      `ws-token:${token}`,
      expect.stringContaining(TENANT_ID),
      'EX',
      60,
    );
  });
});
