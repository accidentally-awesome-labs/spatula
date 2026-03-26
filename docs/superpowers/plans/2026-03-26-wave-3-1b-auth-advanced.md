# Wave 3-1b: Auth Advanced Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JWT authentication, Redis-backed rate limiting, tenant resource quotas, WebSocket token auth, and audit logging — building on the auth core from Wave 3-1a.

**Architecture:** The `JwtAuthProvider` validates OIDC tokens via cached JWKS and plugs into the existing `createAuthProvider()` factory. Rate limiting uses a Redis Lua script for atomic sliding-window counting, wired as middleware after auth. Tenant quotas are stored as JSONB on the `tenants` table and enforced at 4 points (job start, crawl, export, storage). WebSocket auth replaces the legacy `?tenantId=` query param with single-use Redis tokens. An `AuditLogger` service writes fire-and-forget records for auth events, API key lifecycle, and job operations.

**Tech Stack:** TypeScript, Hono, `jose` (JWT), `ioredis`, Drizzle ORM (Postgres), Vitest

**Spec references:**
- Phase 12 spec: sections 3.1.3, 3.2, 3.4-3.6
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.2

**Depends on:** Wave 3-1a Auth Core (complete) -- `AuthProvider`, `AuthResult`, `AuthError`, `ForbiddenError`, `requireScope()`, `authMiddleware()`, `createAuthProvider()` factory, `AppDeps.authProvider`, `AppEnv.Variables.auth`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `apps/api/src/auth/jwt-provider.ts` | `JwtAuthProvider` -- OIDC JWT validation via `jose` |
| `apps/api/src/middleware/rate-limit.ts` | Sliding-window rate limiter middleware (Redis Lua) |
| `apps/api/src/routes/ws-token.ts` | `POST /api/v1/ws-token` endpoint |
| `packages/db/src/schema/audit-log.ts` | `audit_log` Drizzle table definition |
| `packages/db/src/repositories/audit-log-repository.ts` | Audit log insert + query |
| `packages/shared/src/auth/audit-logger.ts` | `AuditLogger` service (fire-and-forget writes) |
| `packages/shared/src/auth/rate-limit-tiers.ts` | Rate limit tier definitions and types |
| `packages/shared/src/auth/quotas.ts` | `TenantQuotas` type, defaults, `QuotaExceededError` |
| `apps/api/tests/unit/auth/jwt-provider.test.ts` | JWT provider tests |
| `apps/api/tests/unit/middleware/rate-limit.test.ts` | Rate limit middleware tests |
| `apps/api/tests/unit/routes/ws-token.test.ts` | WS token endpoint tests |
| `packages/db/tests/unit/repositories/audit-log-repository.test.ts` | Audit log repo tests |
| `packages/shared/tests/unit/auth/audit-logger.test.ts` | AuditLogger tests |

### Modified Files

| File | Change |
|------|--------|
| `apps/api/src/auth/factory.ts` | Add `JwtAuthProvider` case, extend `AuthProviderDeps` |
| `apps/api/src/auth/index.ts` | Export JWT provider |
| `apps/api/src/types.ts` | Add `redis`, `auditLogger`, `auditLogRepo` to `AppDeps` |
| `apps/api/src/app.ts` | Add rate limit middleware, ws-token route, quota loading |
| `apps/api/src/server.ts` | WS token auth replacing legacy `?tenantId=` fallback |
| `packages/db/src/schema/tenants.ts` | Add `quotas` JSONB column + `storageBytesUsed` |
| `packages/db/src/schema/index.ts` | Export `auditLog` table |
| `packages/db/src/repositories/index.ts` | Export `AuditLogRepository` |
| `packages/db/src/repositories/tenant-repository.ts` | Add `getQuotas()` and `incrementStorageBytes()` methods |
| `packages/shared/src/auth/index.ts` | Export audit logger, quotas, rate limit tiers |
| `packages/shared/src/index.ts` | Already exports auth barrel |
| `packages/queue/src/job-manager.ts` | Quota check in `startJob()` |
| `packages/core/src/pipeline/export-orchestrator.ts` | Per-tenant `maxEntitiesPerExport` |
| `packages/db/src/content-store/pg-content-store.ts` | Storage byte tracking |
| `apps/api/src/middleware/error-handler.ts` | Map `QUOTA_EXCEEDED` to 429 |

---

## Task 1: Shared Redis Client + Rate Limit Types

**Files:**
- Create: `packages/shared/src/auth/rate-limit-tiers.ts`
- Create: `packages/shared/src/auth/quotas.ts`
- Modify: `packages/shared/src/auth/index.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`

- [ ] **Step 1: Define rate limit tier types and constants**

```typescript
// packages/shared/src/auth/rate-limit-tiers.ts

export interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  free: { name: 'free', requestsPerMinute: 60, maxConcurrentJobs: 2 },
  standard: { name: 'standard', requestsPerMinute: 300, maxConcurrentJobs: 10 },
  enterprise: { name: 'enterprise', requestsPerMinute: 1500, maxConcurrentJobs: 50 },
  unlimited: { name: 'unlimited', requestsPerMinute: Infinity, maxConcurrentJobs: Infinity },
};
```

- [ ] **Step 2: Define tenant quotas type**

```typescript
// packages/shared/src/auth/quotas.ts
import { SpatulaError } from '../errors.js';
import type { SpatulaErrorOptions } from '../errors.js';

export interface TenantQuotas {
  maxConcurrentJobs: number;
  maxPagesPerJob: number;
  maxEntitiesPerExport: number;
  maxStorageMb: number;
  rateLimitTier: string;
}

export const DEFAULT_TENANT_QUOTAS: TenantQuotas = {
  maxConcurrentJobs: 2,
  maxPagesPerJob: 5000,
  maxEntitiesPerExport: 50000,
  maxStorageMb: 1000,
  rateLimitTier: 'free',
};

export class QuotaExceededError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'QUOTA_EXCEEDED', options);
    this.name = 'QuotaExceededError';
  }
}
```

- [ ] **Step 3: Update auth barrel exports**

Add to `packages/shared/src/auth/index.ts`:

```typescript
export * from './rate-limit-tiers.js';
export * from './quotas.js';
```

- [ ] **Step 4: Add `redis` to AppDeps**

In `apps/api/src/types.ts`, the `Redis` type import already exists. Add to `AppDeps`:

```typescript
  redis?: Redis;  // Shared ioredis client for rate limiting, WS tokens, etc.
```

- [ ] **Step 5: Map `QUOTA_EXCEEDED` error code in error handler**

In `apps/api/src/middleware/error-handler.ts`, add after `FORBIDDEN`:

```typescript
      case 'QUOTA_EXCEEDED':
        return 429;
```

- [ ] **Step 6: Verify build and run existing tests**

Run: `pnpm --filter @spatula/shared build && pnpm --filter @spatula/api build`
Run: `pnpm --filter @spatula/shared test && pnpm --filter @spatula/api test`

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/auth/ apps/api/src/types.ts apps/api/src/middleware/error-handler.ts
git commit -m "feat(shared): add rate limit tiers, tenant quota types, and shared Redis client dep"
```

---

## Task 2: JWT Auth Provider

**Files:**
- Create: `apps/api/src/auth/jwt-provider.ts`
- Create: `apps/api/tests/unit/auth/jwt-provider.test.ts`
- Modify: `apps/api/src/auth/factory.ts`
- Modify: `apps/api/src/auth/index.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Install `jose` dependency**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api add jose`

- [ ] **Step 2: Write failing tests**

```typescript
// apps/api/tests/unit/auth/jwt-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue(vi.fn()),
  jwtVerify: vi.fn(),
}));

import { JwtAuthProvider } from '../../../src/auth/jwt-provider.js';
import { jwtVerify } from 'jose';

const mockedJwtVerify = vi.mocked(jwtVerify);

async function createMockRequest(headers: Record<string, string> = {}) {
  const app = new Hono();
  let capturedReq: any;
  app.get('/test', (c) => {
    capturedReq = c.req;
    return c.text('ok');
  });
  await app.request('/test', { headers });
  return capturedReq;
}

describe('JwtAuthProvider', () => {
  let provider: JwtAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new JwtAuthProvider({
      issuer: 'https://auth.spatula.dev',
      audience: 'https://api.spatula.dev',
      jwksUrl: 'https://auth.spatula.dev/.well-known/jwks.json',
    });
  });

  it('authenticates a valid JWT and extracts claims', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123',
        tenant_id: 'tenant-456',
        scopes: ['jobs:read', 'jobs:write'],
        iss: 'https://auth.spatula.dev',
        aud: 'https://api.spatula.dev',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const req = await createMockRequest({
      authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.test.signature',
    });
    const result = await provider.authenticate(req);

    expect(result.tenantId).toBe('tenant-456');
    expect(result.userId).toBe('user-123');
    expect(result.scopes).toEqual(['jobs:read', 'jobs:write']);
  });

  it('throws AuthError when Authorization header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Authorization header is required',
    );
  });

  it('throws AuthError when JWT is invalid', async () => {
    mockedJwtVerify.mockRejectedValue(new Error('invalid signature'));

    const req = await createMockRequest({
      authorization: 'Bearer invalid.jwt.token',
    });
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('throws AuthError when tenant_id claim is missing', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', scopes: ['jobs:read'] },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const req = await createMockRequest({
      authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.test.signature',
    });
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Missing tenant_id claim',
    );
  });

  it('defaults scopes to empty array when scopes claim is missing', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', tenant_id: 'tenant-456' },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const req = await createMockRequest({
      authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.test.signature',
    });
    const result = await provider.authenticate(req);
    expect(result.scopes).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run jwt-provider`

Expected: FAIL -- module not found.

- [ ] **Step 4: Implement JwtAuthProvider**

```typescript
// apps/api/src/auth/jwt-provider.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';

export interface JwtProviderConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export class JwtAuthProvider implements AuthProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: JwtProviderConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    if (!authHeader) {
      throw new AuthError('Authorization header is required');
    }
    if (!authHeader.startsWith('Bearer ')) {
      throw new AuthError('Bearer token required');
    }

    const token = authHeader.slice(7);
    if (!token) {
      throw new AuthError('Bearer token is empty');
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      payload = result.payload;
    } catch {
      throw new AuthError('Invalid or expired token');
    }

    const tenantId = payload.tenant_id as string | undefined;
    if (!tenantId) {
      throw new AuthError('Missing tenant_id claim');
    }

    const userId = payload.sub ?? 'unknown';
    const scopes = (payload.scopes as string[] | undefined) ?? [];

    return { tenantId, userId, scopes };
  }
}
```

- [ ] **Step 5: Wire JWT into factory**

Modify `apps/api/src/auth/factory.ts`. Add import:

```typescript
import { JwtAuthProvider } from './jwt-provider.js';
import type { JwtProviderConfig } from './jwt-provider.js';
```

Update `AuthProviderDeps`:

```typescript
export interface AuthProviderDeps {
  apiKeyRepo: ApiKeyRepository;
  jwtConfig?: JwtProviderConfig;
}
```

Replace the `jwt` case:

```typescript
    case 'jwt':
      if (!deps.jwtConfig) {
        throw new ConfigError('JWT_ISSUER, JWT_AUDIENCE, and JWT_JWKS_URL are required for jwt strategy');
      }
      return new JwtAuthProvider(deps.jwtConfig);
```

- [ ] **Step 6: Update barrel export**

Add to `apps/api/src/auth/index.ts`:

```typescript
export { JwtAuthProvider } from './jwt-provider.js';
export type { JwtProviderConfig } from './jwt-provider.js';
```

- [ ] **Step 7: Wire JWT config into app.ts**

In `apps/api/src/app.ts`, update the `createAuthProvider` call:

```typescript
  const authProvider = deps.authProvider ?? createAuthProvider(authStrategy, {
    apiKeyRepo: deps.apiKeyRepo!,
    jwtConfig: authStrategy === 'jwt' ? {
      issuer: getEnvOrDefault('JWT_ISSUER', ''),
      audience: getEnvOrDefault('JWT_AUDIENCE', ''),
      jwksUrl: getEnvOrDefault('JWT_JWKS_URL', ''),
    } : undefined,
  });
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @spatula/api test -- --run jwt-provider`

Expected: PASS

- [ ] **Step 9: Run all API tests**

Run: `pnpm --filter @spatula/api test`

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/ apps/api/tests/unit/auth/jwt-provider.test.ts apps/api/src/app.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add JwtAuthProvider with OIDC validation via jose"
```

---

## Task 3: Rate Limit Middleware

**Files:**
- Create: `apps/api/src/middleware/rate-limit.ts`
- Create: `apps/api/tests/unit/middleware/rate-limit.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/rate-limit.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from '../../../src/middleware/rate-limit.js';
import type Redis from 'ioredis';

function createMockRedis() {
  return { eval: vi.fn() } as unknown as Redis;
}

function createTestApp(redis: Redis, tier = 'free') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'u', scopes: ['admin'] });
    c.set('rateLimitTier', tier);
    return next();
  });
  app.use('*', rateLimitMiddleware(redis));
  app.get('/test', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    return c.json({ error: { message: err.message } }, 429);
  });
  return app;
}

describe('rateLimitMiddleware', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('allows request when under limit', async () => {
    (redis as any).eval.mockResolvedValue([1, 5]);
    const app = createTestApp(redis);
    const res = await app.request('/test');

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('55');
  });

  it('rejects request when over limit with 429', async () => {
    (redis as any).eval.mockResolvedValue([0, 60]);
    const app = createTestApp(redis);
    const res = await app.request('/test');

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });

  it('skips rate limiting for unlimited tier', async () => {
    const app = createTestApp(redis, 'unlimited');
    const res = await app.request('/test');

    expect(res.status).toBe(200);
    expect((redis as any).eval).not.toHaveBeenCalled();
  });

  it('uses correct limit for standard tier', async () => {
    (redis as any).eval.mockResolvedValue([1, 10]);
    const app = createTestApp(redis, 'standard');
    const res = await app.request('/test');

    expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('290');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run rate-limit`

Expected: FAIL -- module not found.

- [ ] **Step 3: Implement rate limit middleware**

```typescript
// apps/api/src/middleware/rate-limit.ts
import type { MiddlewareHandler } from 'hono';
import type Redis from 'ioredis';
import { RateLimitError } from '@spatula/shared';
import { RATE_LIMIT_TIERS } from '@spatula/shared';

const WINDOW_MS = 60_000; // 1 minute

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  return {0, count}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
return {1, count + 1}
`;

export function rateLimitMiddleware(redis: Redis): MiddlewareHandler {
  return async (c, next) => {
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      return next();
    }

    const tierName = (c.get('rateLimitTier') as string) ?? 'free';
    const tier = RATE_LIMIT_TIERS[tierName] ?? RATE_LIMIT_TIERS.free;

    if (tier.requestsPerMinute === Infinity) {
      return next();
    }

    const now = Date.now();
    const key = `ratelimit:${tenantId}:${WINDOW_MS}`;
    const member = `${now}:${crypto.randomUUID()}`;

    const result = await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      now.toString(),
      WINDOW_MS.toString(),
      tier.requestsPerMinute.toString(),
      member,
    );

    const [accepted, count] = result as [number, number];

    c.header('X-RateLimit-Limit', tier.requestsPerMinute.toString());
    const remaining = Math.max(0, tier.requestsPerMinute - count);
    c.header('X-RateLimit-Remaining', remaining.toString());

    if (!accepted) {
      c.header('Retry-After', '60');
      throw new RateLimitError('Rate limit exceeded', {
        retryAfterMs: WINDOW_MS,
        context: { tenantId, tier: tierName, limit: tier.requestsPerMinute },
      });
    }

    await next();
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @spatula/api test -- --run rate-limit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/rate-limit.ts apps/api/tests/unit/middleware/rate-limit.test.ts
git commit -m "feat(api): add sliding-window rate limit middleware with Redis Lua script"
```

---

## Task 4: Tenant Quotas Schema + Repository

**Files:**
- Modify: `packages/db/src/schema/tenants.ts`
- Modify: `packages/db/src/repositories/tenant-repository.ts`

- [ ] **Step 1: Add quotas and storageBytesUsed columns to tenants schema**

Replace `packages/db/src/schema/tenants.ts`:

```typescript
import { pgTable, uuid, text, jsonb, timestamp, bigint } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  quotas: jsonb('quotas').notNull().default({
    maxConcurrentJobs: 2,
    maxPagesPerJob: 5000,
    maxEntitiesPerExport: 50000,
    maxStorageMb: 1000,
    rateLimitTier: 'free',
  }),
  storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate migration**

Run: `pnpm --filter @spatula/db db:generate`

Verify migration adds `quotas` and `storage_bytes_used` columns.

- [ ] **Step 3: Add getQuotas() and incrementStorageBytes() to TenantRepository**

Add `sql` import at top of `packages/db/src/repositories/tenant-repository.ts`:

```typescript
import { eq, sql } from 'drizzle-orm';
```

Add methods to the `TenantRepository` class:

```typescript
  async getQuotas(tenantId: string) {
    try {
      const [row] = await this.db
        .select({ quotas: tenants.quotas })
        .from(tenants)
        .where(eq(tenants.id, tenantId));

      if (!row) {
        throw new StorageError(`Tenant ${tenantId} not found`, { context: { id: tenantId } });
      }

      return row.quotas as Record<string, unknown>;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to get quotas: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id: tenantId },
      });
    }
  }

  async incrementStorageBytes(tenantId: string, bytes: number) {
    try {
      await this.db
        .update(tenants)
        .set({ storageBytesUsed: sql`${tenants.storageBytesUsed} + ${bytes}` })
        .where(eq(tenants.id, tenantId));
    } catch (error) {
      throw new StorageError(`Failed to update storage bytes: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, bytes },
      });
    }
  }
```

- [ ] **Step 4: Build and run tests**

Run: `pnpm --filter @spatula/db build && pnpm --filter @spatula/db test`

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/tenants.ts packages/db/src/repositories/tenant-repository.ts packages/db/drizzle/
git commit -m "feat(db): add tenant quotas JSONB column and storage tracking"
```

---

## Task 5: Quota Enforcement

**Files:**
- Modify: `packages/queue/src/job-manager.ts`
- Modify: `packages/core/src/pipeline/export-orchestrator.ts`

- [ ] **Step 1: Add concurrent job quota check in JobManager.startJob()**

Read `packages/queue/src/job-manager.ts` first. Add an optional `tenantRepo` to `JobManagerConfig`:

```typescript
import type { TenantRepository } from '@spatula/db';
```

Add to interface:
```typescript
  tenantRepo?: TenantRepository;
```

Add field + constructor assignment. Then in `startJob()`, before the state transition, add:

```typescript
    // Check concurrent job quota
    if (this.tenantRepo) {
      try {
        const quotas = await this.tenantRepo.getQuotas(tenantId);
        const maxConcurrent = (quotas as any).maxConcurrentJobs ?? 2;
        const runningJobs = await this.jobRepo.findByTenant(tenantId);
        const runningCount = runningJobs.filter((j: any) => j.status === 'running').length;
        if (runningCount >= maxConcurrent) {
          const { QuotaExceededError } = await import('@spatula/shared');
          throw new QuotaExceededError(
            `Concurrent job limit reached: ${runningCount}/${maxConcurrent}`,
            { context: { tenantId, current: runningCount, max: maxConcurrent } },
          );
        }
      } catch (error) {
        // Re-throw QuotaExceededError, swallow other errors (fail-open)
        if ((error as any).code === 'QUOTA_EXCEEDED') throw error;
        logger.warn({ err: error, tenantId }, 'Failed to check job quota');
      }
    }
```

- [ ] **Step 2: Make export entity limit configurable**

In `packages/core/src/pipeline/export-orchestrator.ts`, find the `MAX_EXPORT_ENTITIES` constant and the validation check. Change the validation to accept a configurable limit:

The export orchestrator function accepts deps/config. Add `maxEntities` as an optional parameter to the export config or deps. The simplest approach: check if a `maxEntitiesPerExport` field exists in the export options passed to the orchestrator:

```typescript
    const maxEntities = (options as any)?.maxEntities ?? MAX_EXPORT_ENTITIES;
    if (total > maxEntities) {
      throw new ValidationError(
        `Export too large: ${total} entities exceeds maximum of ${maxEntities.toLocaleString()}.`,
        { context: { exportId, jobId, total, max: maxEntities } },
      );
    }
```

Read the file first to understand the exact function signature and where the validation occurs.

- [ ] **Step 3: Build and test**

Run: `pnpm --filter @spatula/queue build && pnpm --filter @spatula/core build`
Run: `pnpm --filter @spatula/queue test && pnpm --filter @spatula/core test`

- [ ] **Step 4: Commit**

```bash
git add packages/queue/src/job-manager.ts packages/core/src/pipeline/export-orchestrator.ts
git commit -m "feat: add tenant quota enforcement at job start and export"
```

---

## Task 6: Audit Log Table + Repository

**Files:**
- Create: `packages/db/src/schema/audit-log.ts`
- Create: `packages/db/src/repositories/audit-log-repository.ts`
- Create: `packages/db/tests/unit/repositories/audit-log-repository.test.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/repositories/index.ts`

- [ ] **Step 1: Create audit_log Drizzle schema**

```typescript
// packages/db/src/schema/audit-log.ts
import { pgTable, uuid, text, jsonb, timestamp, index, inet } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  actorId: text('actor_id').notNull(),
  actorType: text('actor_type').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  ipAddress: inet('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_audit_tenant_time').on(table.tenantId, table.createdAt),
  index('idx_audit_action_time').on(table.action, table.createdAt),
]);
```

- [ ] **Step 2: Export from schema barrel and generate migration**

Add to `packages/db/src/schema/index.ts`:
```typescript
export * from './audit-log.js';
```

Run: `pnpm --filter @spatula/db db:generate`

- [ ] **Step 3: Write failing repo tests**

```typescript
// packages/db/tests/unit/repositories/audit-log-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogRepository } from '../../../src/repositories/audit-log-repository.js';

function createMockDb() {
  const returning = vi.fn();
  const values = vi.fn().mockReturnValue({ returning });

  return {
    db: {
      insert: vi.fn().mockReturnValue({ values }),
    } as any,
    mocks: { returning, values },
  };
}

describe('AuditLogRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: AuditLogRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new AuditLogRepository(mockDb.db);
  });

  describe('insert', () => {
    it('inserts an audit log entry', async () => {
      const entry = {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        actorType: 'user' as const,
        action: 'job.created',
        resourceType: 'job',
        resourceId: 'job-1',
      };
      mockDb.mocks.returning.mockResolvedValue([{ id: 'log-1', ...entry }]);

      const result = await repo.insert(entry);
      expect(result.id).toBe('log-1');
    });
  });
});
```

- [ ] **Step 4: Implement AuditLogRepository**

```typescript
// packages/db/src/repositories/audit-log-repository.ts
import { eq, desc } from 'drizzle-orm';
import { StorageError } from '@spatula/shared';
import { auditLog } from '../schema/audit-log.js';
import type { Database } from '../connection.js';

export interface AuditLogEntry {
  tenantId?: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export class AuditLogRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: AuditLogEntry) {
    try {
      const [row] = await this.db
        .insert(auditLog)
        .values({
          tenantId: entry.tenantId,
          actorId: entry.actorId,
          actorType: entry.actorType,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          metadata: entry.metadata ?? {},
          ipAddress: entry.ipAddress,
        })
        .returning();
      return row;
    } catch (error) {
      throw new StorageError(`Failed to insert audit log: ${(error as Error).message}`, {
        cause: error as Error,
        context: { action: entry.action },
      });
    }
  }

  async findByTenant(tenantId: string, options?: { limit?: number; offset?: number }) {
    try {
      return await this.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantId))
        .orderBy(desc(auditLog.createdAt))
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to query audit log: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
```

- [ ] **Step 5: Export from barrels**

Add to `packages/db/src/repositories/index.ts`:
```typescript
export { AuditLogRepository } from './audit-log-repository.js';
export type { AuditLogEntry } from './audit-log-repository.js';
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @spatula/db test -- --run audit-log`

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/audit-log.ts packages/db/src/schema/index.ts packages/db/src/repositories/audit-log-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/audit-log-repository.test.ts packages/db/drizzle/
git commit -m "feat(db): add audit_log table and AuditLogRepository"
```

---

## Task 7: AuditLogger Service

**Files:**
- Create: `packages/shared/src/auth/audit-logger.ts`
- Create: `packages/shared/tests/unit/auth/audit-logger.test.ts`
- Modify: `packages/shared/src/auth/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/tests/unit/auth/audit-logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger } from '../../../src/auth/audit-logger.js';

describe('AuditLogger', () => {
  let mockRepo: { insert: ReturnType<typeof vi.fn> };
  let auditLogger: AuditLogger;

  beforeEach(() => {
    mockRepo = { insert: vi.fn().mockResolvedValue({ id: 'log-1' }) };
    auditLogger = new AuditLogger(mockRepo as any);
  });

  it('logs an event fire-and-forget', async () => {
    auditLogger.log({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorType: 'user',
      action: 'job.created',
      resourceType: 'job',
      resourceId: 'job-1',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.created', actorId: 'user-1' }),
    );
  });

  it('does not throw when repo insert fails', async () => {
    mockRepo.insert.mockRejectedValue(new Error('DB down'));

    auditLogger.log({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorType: 'system',
      action: 'auth.login_failure',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRepo.insert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/shared test -- --run audit-logger`

- [ ] **Step 3: Implement AuditLogger**

```typescript
// packages/shared/src/auth/audit-logger.ts
import { createLogger } from '../logger.js';

const logger = createLogger('audit-logger');

export interface AuditLogRepo {
  insert(entry: AuditEvent): Promise<unknown>;
}

export interface AuditEvent {
  tenantId?: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export class AuditLogger {
  constructor(private readonly repo: AuditLogRepo) {}

  log(event: AuditEvent): void {
    setImmediate(() => {
      this.repo.insert(event).catch((err) => {
        logger.warn({ err, event: event.action }, 'Failed to write audit log');
      });
    });
  }
}
```

- [ ] **Step 4: Export from barrel**

Add to `packages/shared/src/auth/index.ts`:
```typescript
export { AuditLogger } from './audit-logger.js';
export type { AuditEvent, AuditLogRepo } from './audit-logger.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @spatula/shared test -- --run audit-logger`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/auth/audit-logger.ts packages/shared/src/auth/index.ts packages/shared/tests/unit/auth/audit-logger.test.ts
git commit -m "feat(shared): add AuditLogger service with fire-and-forget writes"
```

---

## Task 8: WebSocket Token Auth

**Files:**
- Create: `apps/api/src/routes/ws-token.ts`
- Create: `apps/api/tests/unit/routes/ws-token.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/routes/ws-token.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { wsTokenRoutes } from '../../../src/routes/ws-token.js';

function createTestApp(mockRedis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', { redis: mockRedis });
    return next();
  });
  app.route('/api/v1/ws-token', wsTokenRoutes());
  return app;
}

describe('WS Token routes', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = { set: vi.fn().mockResolvedValue('OK') };
  });

  it('creates a WS token stored in Redis with 60s TTL', async () => {
    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/ws-token', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.token).toBeDefined();
    expect(body.data.expiresIn).toBe(60);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^ws-token:/),
      expect.stringContaining('tenant-1'),
      'EX',
      60,
    );
  });
});
```

- [ ] **Step 2: Implement ws-token endpoint**

```typescript
// apps/api/src/routes/ws-token.ts
import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const WS_TOKEN_TTL = 60;

const createWsTokenRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['WebSocket'],
  summary: 'Create a single-use WebSocket auth token',
  responses: {
    200: jsonContent(
      z.object({ data: z.object({ token: z.string(), expiresIn: z.number() }) }),
      'WebSocket token created',
    ),
    500: jsonContent(errorResponseSchema, 'Redis unavailable'),
  },
});

export function wsTokenRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createWsTokenRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');

    if (!deps.redis) {
      throw new Error('Redis not configured');
    }

    const token = randomBytes(32).toString('base64url');
    const key = `ws-token:${token}`;
    const value = JSON.stringify({ tenantId, createdAt: new Date().toISOString() });

    await deps.redis.set(key, value, 'EX', WS_TOKEN_TTL);

    return c.json({ data: { token, expiresIn: WS_TOKEN_TTL } });
  });

  return router;
}
```

- [ ] **Step 3: Update server.ts -- WS token validation**

Read `apps/api/src/server.ts`. Replace the WebSocket tenant extraction logic to support token-based auth when `AUTH_STRATEGY != none`. Add `getEnvOrDefault` import:

```typescript
import { createLogger, loadConfig, getEnvOrDefault } from '@spatula/shared';
```

Replace the WS `onOpen` handler to branch on auth strategy:
- `AUTH_STRATEGY=none`: keep legacy `x-tenant-id` header / `?tenantId=` query param
- Otherwise: require `?token=` param, validate against Redis (get + delete for single-use), extract tenantId

See the full implementation in the plan body above (Task 8, Step 4 from the detailed plan).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @spatula/api test -- --run ws-token`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ws-token.ts apps/api/tests/unit/routes/ws-token.test.ts apps/api/src/server.ts
git commit -m "feat(api): add WebSocket token auth with Redis-backed single-use tokens"
```

---

## Task 9: Wire Rate Limiting + WS Token Route into App

**Files:**
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Add audit deps to AppDeps**

In `apps/api/src/types.ts`, add imports:

```typescript
import type { AuditLogger } from '@spatula/shared';
import type { AuditLogRepository } from '@spatula/db';
```

Add to `AppDeps`:
```typescript
  auditLogger?: AuditLogger;
  auditLogRepo?: AuditLogRepository;
```

- [ ] **Step 2: Update app.ts**

Add imports:
```typescript
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { wsTokenRoutes } from './routes/ws-token.js';
```

After the auth/deps/validateTenant middleware block, add quota loading middleware:

```typescript
  // Load tenant quotas for rate limiting
  app.use('/api/*', async (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId && deps.tenantRepo) {
      try {
        const quotas = await deps.tenantRepo.getQuotas(tenantId);
        c.set('rateLimitTier', (quotas as any).rateLimitTier ?? 'free');
      } catch {
        c.set('rateLimitTier', 'free');
      }
    }
    return next();
  });

  // Rate limiting (after auth + quota loading)
  if (deps.redis) {
    app.use('/api/*', rateLimitMiddleware(deps.redis));
  }
```

Add ws-token route after api-keys:

```typescript
  // WebSocket token endpoint
  if (deps.redis) {
    app.route('/api/v1/ws-token', wsTokenRoutes());
  }
```

- [ ] **Step 3: Run ALL tests**

Run: `pnpm --filter @spatula/api test`

All tests must pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/types.ts apps/api/src/app.ts
git commit -m "feat(api): wire rate limiting, ws-token route, and quota loading into app"
```

---

## Task 10: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`

Expected: All tests pass. New test count should be ~225+ total.

- [ ] **Step 2: Verify key functionality**

Check:
- JWT provider tests pass (5 tests)
- Rate limit middleware tests pass (4 tests)
- WS token tests pass (1+ tests)
- Audit log repo tests pass (1+ tests)
- AuditLogger service tests pass (2 tests)
- All 201 existing API tests still pass

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues in auth advanced wiring"
```
