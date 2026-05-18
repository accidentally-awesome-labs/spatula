# Tier 5B: API Middleware & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 33 end-to-end tests covering API security and middleware: authentication (API key), scope enforcement, multi-tenant isolation, CORS, idempotency, rate limiting, error response consistency, pagination edge cases, security headers, audit logging, tenant header validation, and OpenAPI spec.

**Architecture:** All 5B tests use `app.request()` (no HTTP server, no workers). The Hono app is created with `AUTH_STRATEGY=api-key` via a modified `createTestApp()`. Each test file creates its own app instance to avoid cross-file contamination. A shared helper bootstraps tenants + API keys directly in the database. Tests requiring Redis (idempotency, rate limiting) skip gracefully when Redis is unavailable.

**Tech Stack:** TypeScript, Vitest, Hono `app.request()`, Docker Postgres (port 5433) + Docker Redis (port 6380), `@spatula/db` repositories, `@spatula/shared` (AuditLogger, error types)

---

## File Structure

### New files

| File                                                             | Responsibility                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/cli/tests/e2e/tier5/tier5b/helpers.ts`                     | `createApiKeyDirectly()`, `bearerHeaders()`, `setupAuthContext()`, `setupTenantPair()`, `minimalJobBody()` |
| `apps/cli/tests/e2e/tier5/tier5b/auth-and-scopes.test.ts`        | Tests 1–8: API key CRUD, valid/revoked/malformed auth, scope enforcement                                   |
| `apps/cli/tests/e2e/tier5/tier5b/multi-tenant.test.ts`           | Tests 9–11: Tenant A invisible to B, cross-tenant job/action 404                                           |
| `apps/cli/tests/e2e/tier5/tier5b/cors.test.ts`                   | Tests 12–14: Preflight allowed/disallowed origin, exposed headers                                          |
| `apps/cli/tests/e2e/tier5/tier5b/idempotency.test.ts`            | Tests 15–18: POST cache, replay, different body, DELETE bypass                                             |
| `apps/cli/tests/e2e/tier5/tier5b/rate-limiting.test.ts`          | Tests 19–20: 61st request → 429, per-tenant independence                                                   |
| `apps/cli/tests/e2e/tier5/tier5b/error-consistency.test.ts`      | Tests 21–25: 400/404/409/500 format, wrong Content-Type                                                    |
| `apps/cli/tests/e2e/tier5/tier5b/pagination-and-headers.test.ts` | Tests 26–29: Zero/negative limit, large offset, security headers, X-Request-Id                             |
| `apps/cli/tests/e2e/tier5/tier5b/audit-and-validation.test.ts`   | Tests 30–33: Auth audit events, tenant header validation, OpenAPI spec                                     |

### Modified files

| File                                  | Change                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/cli/tests/e2e/tier4/helpers.ts` | Accept optional `authStrategy` param in `createTestApp()`, expose `repos`, create `AuditLogger` |
| `apps/cli/scripts/tier-registry.ts`   | Add `5b` and `5` tier definitions                                                               |
| `apps/cli/package.json`               | Add `test:tier5b` and `test:tier5` scripts                                                      |

---

## Task 1: Modify Tier 4 helpers for auth strategy support

**Files:**

- Modify: `apps/cli/tests/e2e/tier4/helpers.ts`

- [ ] **Step 1: Add `TestRepos` interface and extend `TestApp`**

Add the following interface and update the `TestApp` interface. Insert these above the existing `TestApp` interface definition:

```typescript
export interface TestRepos {
  jobRepo: JobRepository;
  schemaRepo: SchemaRepository;
  entityRepo: EntityRepository;
  entitySourceRepo: EntitySourceRepository;
  actionRepo: ActionRepository;
  exportRepo: ExportRepository;
  tenantRepo: TenantRepository;
  dlqRepo: DlqRepository;
  apiKeyRepo: ApiKeyRepository;
  auditLogRepo: AuditLogRepository;
}
```

Add `repos: TestRepos;` to the `TestApp` interface:

```typescript
export interface TestApp {
  app: any;
  pool: Pool;
  db: Database;
  redis: RedisClient | null;
  repos: TestRepos;
  cleanup(): Promise<void>;
}
```

- [ ] **Step 2: Add `authStrategy` parameter to `createTestApp`**

Change the function signature from:

```typescript
export async function createTestApp(): Promise<TestApp | null> {
```

to:

```typescript
export async function createTestApp(opts?: {
  authStrategy?: 'none' | 'api-key';
}): Promise<TestApp | null> {
```

Then change the hardcoded auth strategy line:

```typescript
// Old
process.env.AUTH_STRATEGY = 'none';

// New
process.env.AUTH_STRATEGY = opts?.authStrategy ?? 'none';
```

- [ ] **Step 3: Create AuditLogger and add `repos` to return value**

After all repositories are instantiated and before `createApp()` is called, add:

```typescript
const { AuditLogger } = await import('@spatula/shared');
const auditLogger = new AuditLogger(auditLogRepo);
```

Add `auditLogger` to the deps passed to `createApp`:

```typescript
const deps = {
  // ...existing fields...
  auditLogger,
};
```

Update the return statement to include `repos`:

```typescript
return {
  app,
  pool,
  db,
  redis,
  repos: {
    jobRepo,
    schemaRepo,
    entityRepo,
    entitySourceRepo,
    actionRepo,
    exportRepo,
    tenantRepo,
    dlqRepo,
    apiKeyRepo,
    auditLogRepo,
  },
  cleanup: async () => {
    // ...existing cleanup...
  },
};
```

- [ ] **Step 4: Run Tier 4 tests to verify no regression**

Run: `cd apps/cli && pnpm test:tier4`
Expected: All existing Tier 4 tests pass. The new optional parameter and repos field are backward-compatible.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/tests/e2e/tier4/helpers.ts
git commit -m "feat: extend createTestApp with authStrategy param, repos, auditLogger"
```

---

## Task 2: Create Tier 5B test helpers

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/helpers.ts`

- [ ] **Step 1: Write the helpers file**

```typescript
import { createHash, randomBytes } from 'node:crypto';
import { createTestApp, createTenant, type TestApp, type TestRepos } from '../../tier4/helpers.js';
import type { Database } from '@spatula/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthTestContext {
  app: any;
  pool: any;
  db: Database;
  redis: any;
  repos: TestRepos;
  tenantId: string;
  adminKey: string;
  adminKeyId: string;
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// API Key helpers
// ---------------------------------------------------------------------------

/**
 * Insert an API key directly into the database, bypassing the API.
 * Used to bootstrap the first admin key (chicken-and-egg).
 */
export async function createApiKeyDirectly(
  db: Database,
  tenantId: string,
  scopes: string[],
  name = 'test-key',
): Promise<{ rawKey: string; keyId: string }> {
  const random = randomBytes(24).toString('base64url');
  const raw = `sk_live_${random}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);

  const { apiKeys } = await import('@spatula/db/dist/schema/index.js');
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId,
      keyHash: hash,
      keyPrefix: prefix,
      name,
      scopes,
    })
    .returning({ id: apiKeys.id });

  return { rawKey: raw, keyId: row.id };
}

/**
 * Bearer auth headers for API key authentication.
 */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Minimal valid job body for POST /api/v1/jobs.
 */
export function minimalJobBody(overrides?: Record<string, unknown>) {
  return {
    name: 'Test Job',
    seedUrls: ['https://example.com'],
    crawl: { maxDepth: 1, maxPages: 10, concurrency: 1, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'test/model' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Context setup
// ---------------------------------------------------------------------------

/**
 * Create a test app with API key auth, a tenant, and an admin key.
 * Returns null if DATABASE_URL is not set (tests skip gracefully).
 */
export async function setupAuthContext(): Promise<AuthTestContext | null> {
  const result = await createTestApp({ authStrategy: 'api-key' });
  if (!result) return null;

  const { tenantId } = await createTenant(result.app);
  const { rawKey, keyId } = await createApiKeyDirectly(
    result.db,
    tenantId,
    ['admin'],
    'test-admin',
  );

  return {
    app: result.app,
    pool: result.pool,
    db: result.db,
    redis: result.redis,
    repos: result.repos,
    tenantId,
    adminKey: rawKey,
    adminKeyId: keyId,
    cleanup: result.cleanup,
  };
}

/**
 * Create two isolated tenants (A and B), each with their own admin API key.
 * Returns ctx (tenant A context) and tenantB info.
 */
export async function setupTenantPair(): Promise<{
  ctx: AuthTestContext;
  tenantB: { tenantId: string; key: string };
} | null> {
  const ctx = await setupAuthContext();
  if (!ctx) return null;

  const { tenantId: tenantBId } = await createTenant(ctx.app, 'Tenant B');
  const { rawKey } = await createApiKeyDirectly(ctx.db, tenantBId, ['admin'], 'tenant-b-admin');

  return {
    ctx,
    tenantB: { tenantId: tenantBId, key: rawKey },
  };
}

/**
 * Standard skip helper for tests that need database infrastructure.
 */
export function skipIfNoDb(dbAvailable: boolean) {
  return (t: { skip: () => void }) => {
    if (!dbAvailable) t.skip();
  };
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd apps/cli && npx tsc --noEmit`
Expected: No errors from the new helpers file.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/helpers.ts
git commit -m "feat: add Tier 5B test helpers for API key auth"
```

---

## Task 3: Update tier registry and package.json

**Files:**

- Modify: `apps/cli/scripts/tier-registry.ts`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add 5b and 5 tier definitions**

In `apps/cli/scripts/tier-registry.ts`, add after the `'5a'` entry:

```typescript
'5b': {
  name: 'API Security & Middleware',
  description: 'Tier 4 + auth providers, scopes, CORS, idempotency, rate limiting',
  extends: '4',
  services: ['docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/tier5b/'],
},
'5': {
  name: 'Full Server Integration',
  description: 'All Tier 5 tests (5A + 5B)',
  extends: '4',
  services: ['ollama', 'docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/'],
},
```

- [ ] **Step 2: Add test scripts to package.json**

In `apps/cli/package.json`, add after the `test:tier5a` script:

```json
"test:tier5b": "tsx scripts/test-tiers.ts --tier=5b",
"test:tier5": "tsx scripts/test-tiers.ts --tier=5",
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/scripts/tier-registry.ts apps/cli/package.json
git commit -m "feat: register Tier 5B and Tier 5 in tier registry"
```

---

## Task 4: Auth & scope enforcement tests (Tests 1–8)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/auth-and-scopes.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupAuthContext,
  bearerHeaders,
  createApiKeyDirectly,
  minimalJobBody,
  skipIfNoDb,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: API Key Authentication & Scope Enforcement', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;
  let skip: ReturnType<typeof skipIfNoDb>;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
    skip = skipIfNoDb(dbAvailable);
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 1: Create API key → returns key string and id ──────────────
  it('creates API key via API and returns raw key + id', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'new-key', scopes: ['jobs:read', 'jobs:write'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.key).toMatch(/^sk_live_/);
    expect(body.data.name).toBe('new-key');
    expect(body.data.scopes).toEqual(['jobs:read', 'jobs:write']);
  });

  // ── Test 2: Authenticate with valid API key → 200 ──────────────────
  it('authenticates with valid API key', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(200);
  });

  // ── Test 3: Revoked key → 401 ──────────────────────────────────────
  it('rejects revoked API key with 401', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a key via API
    const createRes = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'to-revoke' }),
    });
    const { data: created } = await createRes.json();

    // Revoke it
    const revokeRes = await ctx.app.request(`/api/v1/api-keys/${created.id}`, {
      method: 'DELETE',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(revokeRes.status).toBe(200);

    // Try to use revoked key
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(created.key),
    });
    expect(res.status).toBe(401);
  });

  // ── Test 4: Malformed token → 401 ──────────────────────────────────
  it('rejects malformed token with 401', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: { Authorization: 'Bearer garbage123', 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_ERROR');
  });

  // ── Test 5: Key with jobs:read → GET jobs succeeds ─────────────────
  it('allows GET with jobs:read scope', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(ctx.db, ctx.tenantId, ['jobs:read'], 'read-only');
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(rawKey),
    });
    expect(res.status).toBe(200);
  });

  // ── Test 6: Key with jobs:read → POST jobs rejected → 403 ─────────
  it('rejects POST with jobs:read-only scope', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(
      ctx.db,
      ctx.tenantId,
      ['jobs:read'],
      'read-only-2',
    );
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // ── Test 7: Admin scope → all endpoints succeed ────────────────────
  it('allows admin scope on all endpoints', async (t) => {
    if (!dbAvailable) return t.skip();
    // Admin key: GET (read) and POST to api-keys (manage)
    const getRes = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(getRes.status).toBe(200);

    const keyRes = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'admin-created' }),
    });
    expect(keyRes.status).toBe(201);

    const jobRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(jobRes.status).toBe(201);
  });

  // ── Test 8: Empty scopes → all write endpoints rejected → 403 ─────
  it('rejects all writes with empty scopes', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(ctx.db, ctx.tenantId, [], 'no-scopes');

    const jobPost = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(jobPost.status).toBe(403);

    const keyPost = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify({ name: 'blocked' }),
    });
    expect(keyPost.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 8 tests pass (or skip if no database).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/auth-and-scopes.test.ts
git commit -m "test: add API key auth and scope enforcement tests (Tier 5B, tests 1-8)"
```

---

## Task 5: Multi-tenant isolation tests (Tests 9–11)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/multi-tenant.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTenantPair, bearerHeaders, minimalJobBody, type AuthTestContext } from './helpers.js';

describe('Tier 5B: Multi-Tenant Isolation', () => {
  let ctx: AuthTestContext;
  let tenantB: { tenantId: string; key: string };
  let dbAvailable = false;
  let tenantAJobId: string;

  beforeAll(async () => {
    const result = await setupTenantPair();
    if (!result) return;
    ctx = result.ctx;
    tenantB = result.tenantB;
    dbAvailable = true;

    // Create a job in tenant A
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody({ name: 'Tenant A Job' })),
    });
    const body = await res.json();
    tenantAJobId = body.data.id;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 9: Tenant A data invisible to Tenant B ────────────────────
  it('tenant A jobs invisible to tenant B', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(tenantB.key),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  // ── Test 10: Tenant B GET tenant A job by ID → 404 ────────────────
  it('tenant B cannot access tenant A job by ID', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request(`/api/v1/jobs/${tenantAJobId}`, {
      headers: bearerHeaders(tenantB.key),
    });
    expect(res.status).toBe(404);
  });

  // ── Test 11: Tenant B cannot approve tenant A action → 404 ────────
  it('tenant B cannot modify tenant A actions', async (t) => {
    if (!dbAvailable) return t.skip();

    // Insert an action for tenant A's job directly via DB
    // Note: actions table requires source, confidence, reasoning (NOT NULL columns)
    const { actions } = await import('@spatula/db/dist/schema/index.js');
    const [action] = await ctx.db
      .insert(actions)
      .values({
        jobId: tenantAJobId,
        tenantId: ctx.tenantId,
        type: 'add_field',
        status: 'pending_review',
        payload: { field: 'test', reason: 'test action' },
        source: 'schema_evolution',
        confidence: 0.9,
        reasoning: 'test action for multi-tenant isolation',
      })
      .returning({ id: actions.id });

    // Tenant B tries to approve tenant A's action
    const res = await ctx.app.request(`/api/v1/jobs/${tenantAJobId}/actions/${action.id}/approve`, {
      method: 'POST',
      headers: bearerHeaders(tenantB.key),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/multi-tenant.test.ts
git commit -m "test: add multi-tenant isolation tests (Tier 5B, tests 9-11)"
```

---

## Task 6: CORS tests (Tests 12–14)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/cors.test.ts`

- [ ] **Step 1: Write the test file**

CORS in this app: Hono's `cors()` with `origin: allowedOrigins` from `CORS_ALLOWED_ORIGINS` env (default: `http://localhost:3000`). The cors middleware runs before auth, so OPTIONS preflight returns before reaching auth middleware.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupAuthContext, bearerHeaders, type AuthTestContext } from './helpers.js';

describe('Tier 5B: CORS', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 12: Preflight from allowed origin → correct headers ──────
  it('returns CORS headers for allowed origin preflight', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });
    // Hono cors returns 204 for preflight
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  // ── Test 13: Preflight from disallowed origin → no ACAO header ────
  it('does not return ACAO for disallowed origin', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // ── Test 14: Response exposes rate limit and request-id headers ────
  it('exposes rate limit and request-id headers via CORS', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: {
        ...bearerHeaders(ctx.adminKey),
        Origin: 'http://localhost:3000',
      },
    });
    expect(res.status).toBe(200);
    const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('X-RateLimit-Limit');
    expect(exposed).toContain('X-Request-Id');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 14 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/cors.test.ts
git commit -m "test: add CORS tests (Tier 5B, tests 12-14)"
```

---

## Task 7: Idempotency tests (Tests 15–18)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/idempotency.test.ts`

- [ ] **Step 1: Write the test file**

Idempotency middleware: applies to POST/PATCH only, uses Redis (`idempotency:{tenantId}:{key}`), caches 2xx JSON responses for 24h. All idempotency tests require Redis.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupAuthContext,
  bearerHeaders,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Idempotency', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;

    // Flush Redis to prevent stale idempotency keys from prior runs
    if (ctx.redis) await ctx.redis.flushdb();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  function skipIfNoDB(t: { skip: () => void }) {
    if (!dbAvailable) t.skip();
  }
  function skipIfNoRedis(t: { skip: () => void }) {
    if (!dbAvailable || !ctx.redis) t.skip();
  }

  // Shared state for tests 15-17 (sequential within describe)
  const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let firstJobId: string;

  // ── Test 15: POST with Idempotency-Key → 201 ─────────────────────
  it('POST with Idempotency-Key creates resource', async (t) => {
    skipIfNoRedis(t);
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Idempotent Job' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    firstJobId = body.data.id;
    expect(firstJobId).toBeDefined();
  });

  // ── Test 16: Same key again → cached 201 (no duplicate) ──────────
  it('same Idempotency-Key returns cached response', async (t) => {
    skipIfNoRedis(t);
    if (!firstJobId) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Idempotent Job' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(firstJobId); // Same ID — cached, not new
  });

  // ── Test 17: Same key, different body → cached response ───────────
  it('same Idempotency-Key ignores different body', async (t) => {
    skipIfNoRedis(t);
    if (!firstJobId) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(minimalJobBody({ name: 'Completely Different Name' })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(firstJobId); // Still cached original
  });

  // ��─ Test 18: Idempotency only applies to POST/PATCH ───────────────
  it('ignores Idempotency-Key on DELETE', async (t) => {
    skipIfNoDB(t);
    // Create a job to delete
    const createRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody({ name: 'Delete Target' })),
    });
    const { data: job } = await createRes.json();
    const deleteKey = `del-${Date.now()}`;

    // First DELETE with Idempotency-Key → 204 (job deleted, no content)
    // Note: DELETE returns 204 with no body. The idempotency middleware only
    // caches JSON 2xx responses, so 204 is never cached regardless of method filter.
    const del1 = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      method: 'DELETE',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': deleteKey },
    });
    expect(del1.status).toBe(204);

    // Second DELETE with same key → 404 (proves NOT cached)
    const del2 = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      method: 'DELETE',
      headers: { ...bearerHeaders(ctx.adminKey), 'Idempotency-Key': deleteKey },
    });
    expect(del2.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 18 tests pass (idempotency tests skip if Redis unavailable).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/idempotency.test.ts
git commit -m "test: add idempotency middleware tests (Tier 5B, tests 15-18)"
```

---

## Task 8: Rate limiting tests (Tests 19–20)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/rate-limiting.test.ts`

- [ ] **Step 1: Write the test file**

Rate limit: Redis sorted-set sliding window, 60-second window, free tier = 60 req/min. Each test creates a dedicated tenant to avoid polluting other tests' counters.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenant } from '../../tier4/helpers.js';
import {
  setupAuthContext,
  bearerHeaders,
  createApiKeyDirectly,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Rate Limiting', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;

    // Flush Redis to prevent stale rate limit counters from prior runs
    if (ctx.redis) await ctx.redis.flushdb();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 19: 61 rapid requests → 61st returns 429 ────────────────
  it('returns 429 after exceeding free-tier rate limit (60/min)', async (t) => {
    if (!dbAvailable || !ctx.redis) return t.skip();

    // Dedicated tenant to avoid cross-test pollution
    const { tenantId } = await createTenant(ctx.app, 'Rate Limit Test');
    const { rawKey } = await createApiKeyDirectly(ctx.db, tenantId, ['jobs:read'], 'rate-key');

    let got429 = false;
    for (let i = 0; i < 61; i++) {
      const res = await ctx.app.request('/api/v1/jobs', {
        headers: bearerHeaders(rawKey),
      });
      if (res.status === 429) {
        const body = await res.json();
        expect(body.error.code).toBe('RATE_LIMIT_ERROR');
        expect(res.headers.get('Retry-After')).toBe('60');
        expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  }, 30_000);

  // ── Test 20: Rate limit per-tenant ────────────────────────────────
  it('rate limits independently per tenant', async (t) => {
    if (!dbAvailable || !ctx.redis) return t.skip();

    // Two fresh tenants
    const { tenantId: tA } = await createTenant(ctx.app, 'Rate A');
    const { rawKey: keyA } = await createApiKeyDirectly(ctx.db, tA, ['jobs:read'], 'rate-a');
    const { tenantId: tB } = await createTenant(ctx.app, 'Rate B');
    const { rawKey: keyB } = await createApiKeyDirectly(ctx.db, tB, ['jobs:read'], 'rate-b');

    // Exhaust tenant A's limit
    for (let i = 0; i < 61; i++) {
      await ctx.app.request('/api/v1/jobs', { headers: bearerHeaders(keyA) });
    }

    // Tenant B should still succeed
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(keyB),
    });
    expect(res.status).toBe(200);
  }, 30_000);
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 20 tests pass (rate limit tests skip without Redis).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/rate-limiting.test.ts
git commit -m "test: add rate limiting tests (Tier 5B, tests 19-20)"
```

---

## Task 9: Error response consistency tests (Tests 21–25)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/error-consistency.test.ts`

- [ ] **Step 1: Write the test file**

Error format: `{ error: { code: string, message: string, requestId?: string } }`. The error handler adds `requestId`; inline error returns (e.g. DLQ routes) may omit it. Tests check code + message at minimum.

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  setupAuthContext,
  bearerHeaders,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: Error Response Consistency', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 21: 400 validation error format ──────────────────────────
  it('returns 400 VALIDATION_ERROR for invalid body', async (t) => {
    if (!dbAvailable) return t.skip();
    // POST a job with missing required fields
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'only name, missing everything' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBeDefined();
  });

  // ── Test 22: 404 not found format ─────────────────────────────────
  it('returns 404 NOT_FOUND for nonexistent job', async (t) => {
    if (!dbAvailable) return t.skip();
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ctx.app.request(`/api/v1/jobs/${fakeId}`, {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeDefined();
    expect(body.error.requestId).toBeDefined();
  });

  // ── Test 23: 409 conflict format (DLQ already resolved) ──────────
  it('returns 409 for already-resolved DLQ entry', async (t) => {
    if (!dbAvailable) return t.skip();
    // Insert a DLQ entry directly
    const { id: dlqId } = await ctx.repos.dlqRepo.insert({
      queueName: 'spatula.test',
      jobId: 'test-bull-job-id',
      tenantId: ctx.tenantId,
      payload: { test: true },
      errorMessage: 'test failure',
      attempts: 1,
    });

    // First discard → 200
    const res1 = await ctx.app.request(`/api/v1/admin/dlq/${dlqId}/discard`, {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res1.status).toBe(200);

    // Second discard → 409 (already resolved)
    const res2 = await ctx.app.request(`/api/v1/admin/dlq/${dlqId}/discard`, {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body.error.code).toBe('ALREADY_RESOLVED');
    expect(body.error.message).toBeDefined();
  });

  // ── Test 24: 500 unhandled exception format ───────────────────────
  it('returns 500 INTERNAL_ERROR for unhandled exceptions', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a job first (before the spy) so we have a valid ID
    const createRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody()),
    });
    const { data: job } = await createRes.json();

    // Now spy on findById to throw — set up AFTER job creation to avoid
    // accidental consumption by unrelated middleware calls
    const spy = vi
      .spyOn(ctx.repos.jobRepo, 'findById')
      .mockRejectedValueOnce(new Error('database exploded'));

    const res = await ctx.app.request(`/api/v1/jobs/${job.id}`, {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error'); // Generic for 5xx
    expect(body.error.requestId).toBeDefined();

    spy.mockRestore();
  });

  // ── Test 25: POST with wrong Content-Type ─────────────────────────
  it('rejects POST with wrong Content-Type', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'text/plain',
      },
      body: 'this is not json',
    });
    // Should be 400 (parse/validation error) or 415 (unsupported media type)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 25 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/error-consistency.test.ts
git commit -m "test: add error response consistency tests (Tier 5B, tests 21-25)"
```

---

## Task 10: Pagination & headers tests (Tests 26–29)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/pagination-and-headers.test.ts`

- [ ] **Step 1: Write the test file**

Pagination: `limit` min 1 (via `z.coerce.number().int().min(1)`), `offset` min 0. Security headers: set by `securityHeaders` middleware on all responses. Request ID: set by `requestContextMiddleware`.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupAuthContext, bearerHeaders, type AuthTestContext } from './helpers.js';

describe('Tier 5B: Pagination Edge Cases & Security Headers', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 26: Zero or negative limit → 400 ────────────────────────
  it('rejects limit=0 with validation error', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs?limit=0', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(400);
  });

  // ── Test 27: Offset beyond total → 200 with empty data ───────────
  it('returns empty data for offset beyond total', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs?offset=999999', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  // ── Test 28: Security headers present ─────────────────────────────
  it('includes security headers on every response', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  // ── Test 29: X-Request-Id header present ──────────────────────────
  it('includes X-Request-Id with UUID-like value', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeDefined();
    // UUID format: 8-4-4-4-12 hex chars
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: 29 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/pagination-and-headers.test.ts
git commit -m "test: add pagination edge case and security header tests (Tier 5B, tests 26-29)"
```

---

## Task 11: Audit logging, tenant validation & OpenAPI tests (Tests 30–33)

**Files:**

- Create: `apps/cli/tests/e2e/tier5/tier5b/audit-and-validation.test.ts`

- [ ] **Step 1: Write the test file**

Audit events are written asynchronously via `setImmediate()`. Tests wait 100ms after the request before querying the audit_log table. Test 32 (tenant header validation) uses `AUTH_STRATEGY=none` to test the NoAuth provider's UUID validation on `x-tenant-id`.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, createTenant } from '../../tier4/helpers.js';
import { setupAuthContext, bearerHeaders, type AuthTestContext } from './helpers.js';

/** Small delay to let async audit writes complete (setImmediate-based). */
const waitForAudit = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('Tier 5B: Audit Logging, Tenant Validation & OpenAPI', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 30: Successful auth → auth.login_success audit entry ─────
  it('logs auth.login_success on successful authentication', async (t) => {
    if (!dbAvailable) return t.skip();

    // Make an authenticated request
    await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    await waitForAudit();

    // Query audit log for success events
    const entries = await ctx.repos.auditLogRepo.findByTenant(ctx.tenantId);
    const successEvents = entries.filter(
      (e: { action: string }) => e.action === 'auth.login_success',
    );
    expect(successEvents.length).toBeGreaterThan(0);
  });

  // ── Test 31: Failed auth → auth.login_failure audit entry ─────────
  it('logs auth.login_failure on failed authentication', async (t) => {
    if (!dbAvailable) return t.skip();

    // Record timestamp before the request to filter out stale entries
    const before = new Date();

    // Make a request with an invalid token
    await ctx.app.request('/api/v1/jobs', {
      headers: {
        Authorization: 'Bearer invalid-key-for-audit',
        'Content-Type': 'application/json',
      },
    });
    await waitForAudit();

    // Failure events may not have a tenantId (auth failed before resolving tenant).
    // Query the audit_log table directly for failure events with a timestamp filter
    // to avoid matching stale entries from prior test runs.
    const { auditLog } = await import('@spatula/db/dist/schema/index.js');
    const { eq, gte, and } = await import('drizzle-orm');
    const failures = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.login_failure'), gte(auditLog.createdAt, before)))
      .limit(10);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].action).toBe('auth.login_failure');
  });

  // ── Test 32: Empty or invalid UUID in x-tenant-id → 400/401 ──────
  // Uses AUTH_STRATEGY=none to test the NoAuth provider's UUID validation.
  it('rejects empty or invalid x-tenant-id in no-auth mode', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a separate app with AUTH_STRATEGY=none
    const noAuthApp = await createTestApp({ authStrategy: 'none' });
    if (!noAuthApp) return t.skip();

    try {
      // Empty tenant ID
      const res1 = await noAuthApp.app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': '', 'Content-Type': 'application/json' },
      });
      expect(res1.status).toBe(401);

      // Invalid UUID
      const res2 = await noAuthApp.app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': 'not-a-uuid', 'Content-Type': 'application/json' },
      });
      expect(res2.status).toBe(401);
    } finally {
      await noAuthApp.cleanup();
    }
  });

  // ── Test 33: /api/openapi.json returns valid spec ─────────────────
  it('serves valid OpenAPI spec with registered routes', async (t) => {
    if (!dbAvailable) return t.skip();
    // No auth needed — openapi.json is in SKIP_AUTH_PATHS
    const res = await ctx.app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toMatch(/^3\./); // OpenAPI 3.x
    expect(body.paths).toBeDefined();
    // Spot-check: /api/v1/jobs path exists
    const jobsPath = body.paths['/api/v1/jobs'];
    expect(jobsPath).toBeDefined();
    expect(jobsPath.get).toBeDefined();
    expect(jobsPath.post).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/cli && pnpm test:tier5b`
Expected: All 33 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier5/tier5b/audit-and-validation.test.ts
git commit -m "test: add audit logging, tenant validation, and OpenAPI tests (Tier 5B, tests 30-33)"
```

---

## Test Summary

| File                           | Tests  | Needs Redis |
| ------------------------------ | ------ | ----------- |
| auth-and-scopes.test.ts        | 8      | No          |
| multi-tenant.test.ts           | 3      | No          |
| cors.test.ts                   | 3      | No          |
| idempotency.test.ts            | 4      | Yes         |
| rate-limiting.test.ts          | 2      | Yes         |
| error-consistency.test.ts      | 5      | No          |
| pagination-and-headers.test.ts | 4      | No          |
| audit-and-validation.test.ts   | 4      | No          |
| **Total**                      | **33** |             |

---

## Key Implementation Notes

1. **API Key Bootstrap (chicken-and-egg):** The first API key is inserted directly into the database via Drizzle (`createApiKeyDirectly`). Subsequent keys can be created via `POST /api/v1/api-keys` with the admin key. The tenant is created via `POST /api/v1/tenants` (which is unauthenticated per `SKIP_AUTH_PREFIXES`).

2. **Admin DLQ Routes:** Located at `/api/v1/admin/dlq/*` (NOT `/admin/dlq`). They go through the full `/api/*` middleware chain and require `admin` scope. The discard route returns 409 inline with `{ error: { code: 'ALREADY_RESOLVED', message: '...' } }` — this is NOT via the error handler, so it may not include `requestId`.

3. **Action Routes:** Nested under jobs: `POST /api/v1/jobs/:jobId/actions/:actionId/approve`. Scope: `actions:write`.

4. **Audit Logger Async:** Auth events are written via `setImmediate()`. Tests must `setTimeout(150)` before querying the audit_log table. Failure events may lack a tenantId (auth failed before resolving tenant).

5. **Rate Limit Window:** Redis sorted-set sliding window, 60-second window. All 61 requests in a tight loop fall in the same window. Free tier = 60/min, so request #61 gets 429.

6. **CORS origin check:** Hono's `cors()` with an array of allowed origins. Matches → reflects origin in ACAO. No match → ACAO header absent.

7. **Pagination validation:** Zod schema `limit: z.coerce.number().int().min(1)` — `limit=0` fails validation → 400 via the OpenAPI `defaultHook`.

8. **Tenant header validation (Test 32):** Uses a separate `AUTH_STRATEGY=none` app instance because with api-key auth, `x-tenant-id` is ignored (tenant comes from the key).
