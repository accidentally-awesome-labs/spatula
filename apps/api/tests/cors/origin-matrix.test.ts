/**
 * CORS origin request-matrix integration test (AUTH-03).
 *
 * Boots the app with a known CORS_ALLOWED_ORIGINS value and exercises
 * the full request matrix: exact origins, single-label wildcard hits,
 * two-label wildcard rejects, suffix-attack rejects, and unlisted rejects.
 * Also covers the boot-fail path when CORS_ALLOWED_ORIGINS is empty.
 *
 * Pattern: createApp() with mocked deps + process.env injection, matching
 * the existing tests/sse/job-events.test.ts harness style.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function createMockDeps(): AppDeps {
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
    eval: vi.fn().mockResolvedValue([100, 50, Date.now() + 60000]),
  };

  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    redis: mockRedis,
    jobRepo: {
      findById: vi.fn().mockResolvedValue(null),
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
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
  } as unknown as AppDeps;
}

/**
 * Send a preflight OPTIONS request to /health and return the response.
 * We use /health because it requires no auth and always returns 200/204,
 * which isolates the CORS behavior cleanly.
 */
async function preflight(app: ReturnType<typeof createApp>, origin: string) {
  return app.request('/health', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
    },
  });
}

/**
 * Send a GET request with an Origin header and return the response.
 */
async function getWithOrigin(app: ReturnType<typeof createApp>, origin: string) {
  return app.request('/health', {
    method: 'GET',
    headers: { Origin: origin },
  });
}

describe('CORS origin request matrix', () => {
  let savedCorsOrigins: string | undefined;

  beforeEach(() => {
    savedCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  });

  afterEach(() => {
    if (savedCorsOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = savedCorsOrigins;
    }
  });

  /**
   * Helper: creates an app with the given CORS_ALLOWED_ORIGINS value.
   * Must be called AFTER setting process.env.CORS_ALLOWED_ORIGINS.
   */
  function createTestApp(corsOrigins: string): ReturnType<typeof createApp> {
    process.env.CORS_ALLOWED_ORIGINS = corsOrigins;
    return createApp(createMockDeps());
  }

  // ── 1. Allowed exact origin ──────────────────────────────────────────────

  it('preflight: allowed exact origin → Access-Control-Allow-Origin echoes back', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await preflight(app, 'https://app.example.com');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });

  // ── 2. Allowed wildcard origin (single label) ────────────────────────────

  it('GET: wildcard single-label match → Access-Control-Allow-Origin echoes back', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await getWithOrigin(app, 'https://web.spatula.dev');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://web.spatula.dev');
  });

  // ── 3. Rejected: two-label subdomain ────────────────────────────────────

  it('GET: two-label subdomain origin (foo.bar.spatula.dev) → NO Access-Control-Allow-Origin', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await getWithOrigin(app, 'https://foo.bar.spatula.dev');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── 4. Rejected: suffix attack ───────────────────────────────────────────

  it('GET: suffix-attack origin (evil.spatula.dev.attacker.com) → NO Access-Control-Allow-Origin', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await getWithOrigin(app, 'https://evil.spatula.dev.attacker.com');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── 5. Rejected: unlisted origin ────────────────────────────────────────

  it('GET: unlisted origin → NO Access-Control-Allow-Origin', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await getWithOrigin(app, 'https://unlisted.com');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── 6. exposeHeaders includes X-RateLimit-Reset and Retry-After (D-09) ──

  it('allowed-origin response includes X-RateLimit-Reset + Retry-After in expose-headers', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await getWithOrigin(app, 'https://app.example.com');
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    expect(exposed).toContain('X-RateLimit-Reset');
    expect(exposed).toContain('Retry-After');
  });

  // ── 7. Preflight cache: Access-Control-Max-Age = 86400 ───────────────────

  it('preflight response Access-Control-Max-Age is 86400', async () => {
    const app = createTestApp('https://app.example.com,https://*.spatula.dev');
    const res = await preflight(app, 'https://app.example.com');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  // ── 8. Boot-fail: empty CORS_ALLOWED_ORIGINS throws CORS_CONFIG_INVALID ──

  it('createApp throws Error with CORS_CONFIG_INVALID when CORS_ALLOWED_ORIGINS is empty', () => {
    process.env.CORS_ALLOWED_ORIGINS = '';
    expect(() => createApp(createMockDeps())).toThrow(/CORS_CONFIG_INVALID/);
  });
});
