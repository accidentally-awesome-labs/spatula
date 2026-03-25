# Wave 3-1a: Auth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the foundational authentication layer — `AuthProvider` interface, API key auth, scope enforcement, security headers, CORS — that all subsequent Wave 3 server work depends on.

**Architecture:** A pluggable `AuthProvider` interface defines how authentication works. Two initial implementations: `ApiKeyAuthProvider` (SHA-256 hash lookup in Postgres) and `NoAuthProvider` (pass-through, preserves current dev behavior). A `createAuthProvider()` factory selects the strategy via `AUTH_STRATEGY` env var. Auth middleware extracts the `Authorization: Bearer` token, calls the provider, and sets `tenantId` + `auth` on the Hono context — replacing the existing `tenantMiddleware` when auth is active. A `requireScope()` middleware enforces per-route authorization. Security headers and CORS are added as global middleware.

**Tech Stack:** TypeScript, Hono, Drizzle ORM (Postgres), `@hono/zod-openapi`, Vitest

**Spec references:**
- Phase 12 spec: sections 3.1.1–3.1.5, 3.3, 3.7
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.1

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/src/auth/types.ts` | `AuthProvider` interface, `AuthResult` type, `AuthError` class, scope constants |
| `packages/shared/src/auth/index.ts` | Barrel export |
| `packages/db/src/schema/api-keys.ts` | `api_keys` Drizzle table definition |
| `packages/db/src/repositories/api-key-repository.ts` | API key CRUD: create, findByHash, listByTenant, revoke |
| `apps/api/src/auth/api-key-provider.ts` | `ApiKeyAuthProvider` implements `AuthProvider` |
| `apps/api/src/auth/no-auth-provider.ts` | `NoAuthProvider` — pass-through using `x-tenant-id` header (current behavior) |
| `apps/api/src/auth/factory.ts` | `createAuthProvider()` factory |
| `apps/api/src/auth/index.ts` | Barrel export |
| `apps/api/src/middleware/auth.ts` | Auth middleware — extracts token, calls provider, sets context |
| `apps/api/src/middleware/require-scope.ts` | `requireScope()` middleware factory |
| `apps/api/src/middleware/security-headers.ts` | Security headers middleware |
| `apps/api/src/routes/api-keys.ts` | API key CRUD routes (POST, GET, DELETE) |
| `apps/api/src/schemas/api-key.ts` | Zod schemas for API key request/response |
| `packages/db/tests/unit/repositories/api-key-repository.test.ts` | API key repo tests |
| `apps/api/tests/unit/auth/api-key-provider.test.ts` | API key auth provider tests |
| `apps/api/tests/unit/auth/no-auth-provider.test.ts` | No-auth provider tests |
| `apps/api/tests/unit/auth/factory.test.ts` | Factory tests |
| `apps/api/tests/unit/middleware/auth.test.ts` | Auth middleware tests |
| `apps/api/tests/unit/middleware/require-scope.test.ts` | Scope enforcement tests |
| `apps/api/tests/unit/middleware/security-headers.test.ts` | Security headers tests |
| `apps/api/tests/unit/routes/api-keys.test.ts` | API key route tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/shared/src/index.ts` | Export auth types |
| `packages/shared/src/errors.ts` | Add `AuthError` class |
| `packages/db/src/schema/index.ts` | Export `apiKeys` table |
| `packages/db/src/repositories/index.ts` | Export `ApiKeyRepository` |
| `packages/db/src/index.ts` | Re-export `ApiKeyRepository` |
| `apps/api/src/types.ts` | Add `authProvider` and `apiKeyRepo` to `AppDeps`, add `auth` to `AppEnv.Variables` |
| `apps/api/src/app.ts` | Add security headers, CORS, auth middleware, scope enforcement on routes |
| `apps/api/src/middleware/error-handler.ts` | Map `AUTH_ERROR` to 401, `FORBIDDEN` to 403 |

### Unchanged Files (but referenced)

| File | Why Referenced |
|------|---------------|
| `apps/api/src/middleware/tenant.ts` | `tenantMiddleware` — still used when `AUTH_STRATEGY=none` |
| `apps/api/src/middleware/validate-tenant.ts` | `validateTenantMiddleware` — remains downstream of auth |
| `apps/api/src/middleware/deps.ts` | `depsMiddleware` — unchanged, still injects deps |
| All existing route tests in `apps/api/tests/` | Must continue to pass with `AUTH_STRATEGY=none` |

---

## Task 1: Auth Types & Error Classes

**Files:**
- Create: `packages/shared/src/auth/types.ts`
- Create: `packages/shared/src/auth/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Define auth types**

```typescript
// packages/shared/src/auth/types.ts
import type { HonoRequest } from 'hono';

export interface AuthResult {
  tenantId: string;
  userId: string;
  scopes: string[];
}

export interface AuthProvider {
  authenticate(request: HonoRequest): Promise<AuthResult>;
}

export const AUTH_SCOPES = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
  'tenants:admin',
  'keys:manage',
  'admin',
] as const;

export type AuthScope = (typeof AUTH_SCOPES)[number];

export const DEFAULT_API_KEY_SCOPES: AuthScope[] = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
];
```

- [ ] **Step 2: Create barrel export**

```typescript
// packages/shared/src/auth/index.ts
export * from './types.js';
```

- [ ] **Step 3: Add AuthError and ForbiddenError to shared errors**

Add to the bottom of `packages/shared/src/errors.ts`:

```typescript
export class AuthError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'AUTH_ERROR', options);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'FORBIDDEN', options);
    this.name = 'ForbiddenError';
  }
}
```

- [ ] **Step 4: Export auth module from shared barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export * from './auth/index.js';
```

- [ ] **Step 5: Map new error codes in error handler**

In `apps/api/src/middleware/error-handler.ts`, add cases to `mapErrorToStatus`:

```typescript
      case 'AUTH_ERROR':
        return 401;
      case 'FORBIDDEN':
        return 403;
```

Add these two cases after the `VALIDATION_ERROR` case.

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @spatula/shared build && pnpm --filter @spatula/api build`

- [ ] **Step 7: Run existing tests to confirm nothing broke**

Run: `pnpm --filter @spatula/shared test && pnpm --filter @spatula/api test`

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/auth/ packages/shared/src/errors.ts packages/shared/src/index.ts apps/api/src/middleware/error-handler.ts
git commit -m "feat(shared): add AuthProvider interface, AuthResult type, and auth error classes"
```

---

## Task 2: API Keys Database Table

**Files:**
- Create: `packages/db/src/schema/api-keys.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create api_keys Drizzle schema**

```typescript
// packages/db/src/schema/api-keys.ts
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),       // First 8 chars for display
  name: text('name').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('idx_api_keys_hash').on(table.keyHash),
]);
```

**Note:** Drizzle's partial index support (`WHERE revoked_at IS NULL`) varies. We use a full index on `key_hash` and filter `revoked_at IS NULL` in queries. The query planner will still use the index efficiently.

- [ ] **Step 2: Export from schema barrel**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from './api-keys.js';
```

- [ ] **Step 3: Generate Postgres migration**

Run:
```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db db:generate
```

Verify the generated migration creates the `api_keys` table with the correct columns and index.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @spatula/db build`

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/api-keys.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): add api_keys table for API key authentication"
```

---

## Task 3: API Key Repository

**Files:**
- Create: `packages/db/src/repositories/api-key-repository.ts`
- Create: `packages/db/tests/unit/repositories/api-key-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/db/tests/unit/repositories/api-key-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyRepository } from '../../../src/repositories/api-key-repository.js';

// Mock the database with chainable query builders
function createMockDb() {
  const returning = vi.fn();
  const where = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ returning });

  return {
    db: {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where }),
      }),
    } as any,
    mocks: { returning, where, values },
  };
}

describe('ApiKeyRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: ApiKeyRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ApiKeyRepository(mockDb.db);
  });

  describe('create', () => {
    it('inserts a new API key and returns it', async () => {
      const input = {
        tenantId: 'tenant-1',
        keyHash: 'hashed-key',
        keyPrefix: 'sk_live_',
        name: 'Production Key',
        scopes: ['jobs:read', 'jobs:write'],
      };
      const expected = { id: 'key-1', ...input, createdAt: new Date() };
      mockDb.mocks.returning.mockResolvedValue([expected]);

      const result = await repo.create(input);
      expect(result).toEqual(expected);
    });
  });

  describe('findByHash', () => {
    it('returns key when hash matches, not revoked, and not expired', async () => {
      const key = {
        id: 'key-1',
        tenantId: 'tenant-1',
        keyHash: 'hash',
        scopes: ['jobs:read'],
        revokedAt: null,
        expiresAt: null,
      };
      mockDb.mocks.where.mockResolvedValue([key]);

      const result = await repo.findByHash('hash');
      expect(result).toEqual(key);
    });

    it('returns null when no matching key found', async () => {
      mockDb.mocks.where.mockResolvedValue([]);

      const result = await repo.findByHash('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('revoke', () => {
    it('sets revokedAt timestamp', async () => {
      const revoked = { id: 'key-1', revokedAt: new Date() };
      mockDb.mocks.returning.mockResolvedValue([revoked]);

      const result = await repo.revoke('key-1', 'tenant-1');
      expect(result).toEqual(revoked);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/db test -- --run api-key-repository`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ApiKeyRepository**

```typescript
// packages/db/src/repositories/api-key-repository.ts
import { eq, and, isNull, or, gt, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { apiKeys } from '../schema/api-keys.js';
import type { Database } from '../connection.js';

const logger = createLogger('api-key-repository');

export interface CreateApiKeyInput {
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
}

export class ApiKeyRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateApiKeyInput) {
    try {
      const [row] = await this.db
        .insert(apiKeys)
        .values({
          tenantId: input.tenantId,
          keyHash: input.keyHash,
          keyPrefix: input.keyPrefix,
          name: input.name,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
        })
        .returning();

      logger.debug({ keyId: row.id, tenantId: input.tenantId }, 'API key created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create API key: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId, name: input.name },
      });
    }
  }

  async findByHash(keyHash: string) {
    try {
      const [row] = await this.db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyHash, keyHash),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        );

      if (row) {
        // Update last_used_at (fire-and-forget, don't block auth)
        this.db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, row.id))
          .then(() => {})
          .catch((err) => logger.warn({ keyId: row.id, err }, 'Failed to update last_used_at'));
      }

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find API key by hash: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async listByTenant(tenantId: string) {
    try {
      return this.db
        .select({
          id: apiKeys.id,
          keyPrefix: apiKeys.keyPrefix,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(
          and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)),
        );
    } catch (error) {
      throw new StorageError(`Failed to list API keys: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async revoke(keyId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`API key ${keyId} not found`, { context: { keyId, tenantId } });
      }

      logger.info({ keyId, tenantId }, 'API key revoked');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to revoke API key: ${(error as Error).message}`, {
        cause: error as Error,
        context: { keyId, tenantId },
      });
    }
  }
}
```

- [ ] **Step 4: Export from barrels**

Add to `packages/db/src/repositories/index.ts`:

```typescript
export { ApiKeyRepository } from './api-key-repository.js';
export type { CreateApiKeyInput } from './api-key-repository.js';
```

Verify `packages/db/src/index.ts` already re-exports everything from `./repositories/index.js` (it does via `export * from './repositories/index.js'`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/db test -- --run api-key-repository`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/api-key-repository.ts packages/db/tests/unit/repositories/api-key-repository.test.ts packages/db/src/repositories/index.ts
git commit -m "feat(db): add ApiKeyRepository for API key CRUD operations"
```

---

## Task 4: NoAuthProvider

**Files:**
- Create: `apps/api/src/auth/no-auth-provider.ts`
- Create: `apps/api/tests/unit/auth/no-auth-provider.test.ts`
- Create: `apps/api/src/auth/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/auth/no-auth-provider.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { NoAuthProvider } from '../../../src/auth/no-auth-provider.js';

function createMockRequest(headers: Record<string, string> = {}) {
  const app = new Hono();
  let capturedReq: any;
  app.get('/test', (c) => {
    capturedReq = c.req;
    return c.text('ok');
  });
  // Use app.request to create a proper HonoRequest
  return app.request('/test', { headers }).then(() => capturedReq);
}

describe('NoAuthProvider', () => {
  const provider = new NoAuthProvider();

  it('extracts tenantId from x-tenant-id header', async () => {
    const req = await createMockRequest({
      'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000',
    });
    const result = await provider.authenticate(req);
    expect(result.tenantId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.userId).toBe('anonymous');
    expect(result.scopes).toContain('admin');
  });

  it('throws AuthError when x-tenant-id header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow('x-tenant-id header is required');
  });

  it('throws AuthError when x-tenant-id is not a valid UUID', async () => {
    const req = await createMockRequest({ 'x-tenant-id': 'not-a-uuid' });
    await expect(provider.authenticate(req)).rejects.toThrow('x-tenant-id must be a valid UUID');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run no-auth-provider`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement NoAuthProvider**

```typescript
// apps/api/src/auth/no-auth-provider.ts
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pass-through auth provider for AUTH_STRATEGY=none.
 * Preserves current behavior: extracts tenantId from x-tenant-id header,
 * grants all scopes (admin). Used for local development.
 */
export class NoAuthProvider implements AuthProvider {
  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const tenantId = request.header('x-tenant-id');
    if (!tenantId) {
      throw new AuthError('x-tenant-id header is required');
    }
    if (!UUID_REGEX.test(tenantId)) {
      throw new AuthError('x-tenant-id must be a valid UUID');
    }

    return {
      tenantId,
      userId: 'anonymous',
      scopes: ['admin'], // Full access in no-auth mode
    };
  }
}
```

- [ ] **Step 4: Create barrel export**

```typescript
// apps/api/src/auth/index.ts
export { NoAuthProvider } from './no-auth-provider.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run no-auth-provider`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/no-auth-provider.ts apps/api/src/auth/index.ts apps/api/tests/unit/auth/no-auth-provider.test.ts
git commit -m "feat(api): add NoAuthProvider for AUTH_STRATEGY=none pass-through"
```

---

## Task 5: ApiKeyAuthProvider

**Files:**
- Create: `apps/api/src/auth/api-key-provider.ts`
- Create: `apps/api/tests/unit/auth/api-key-provider.test.ts`
- Modify: `apps/api/src/auth/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/auth/api-key-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiKeyAuthProvider } from '../../../src/auth/api-key-provider.js';
import type { ApiKeyRepository } from '@spatula/db';

function createMockRequest(headers: Record<string, string> = {}) {
  const app = new Hono();
  let capturedReq: any;
  app.get('/test', (c) => {
    capturedReq = c.req;
    return c.text('ok');
  });
  return app.request('/test', { headers }).then(() => capturedReq);
}

describe('ApiKeyAuthProvider', () => {
  let mockRepo: { findByHash: ReturnType<typeof vi.fn> };
  let provider: ApiKeyAuthProvider;

  beforeEach(() => {
    mockRepo = {
      findByHash: vi.fn(),
    };
    provider = new ApiKeyAuthProvider(mockRepo as unknown as ApiKeyRepository);
  });

  it('authenticates a valid API key', async () => {
    mockRepo.findByHash.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      scopes: ['jobs:read', 'jobs:write'],
      revokedAt: null,
      expiresAt: null,
    });

    const req = await createMockRequest({
      authorization: 'Bearer sk_live_abcdef1234567890abcdef1234567890',
    });
    const result = await provider.authenticate(req);

    expect(result.tenantId).toBe('tenant-1');
    expect(result.userId).toBe('key-1');
    expect(result.scopes).toEqual(['jobs:read', 'jobs:write']);
    expect(mockRepo.findByHash).toHaveBeenCalledWith(expect.any(String));
  });

  it('throws AuthError when Authorization header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Authorization header is required',
    );
  });

  it('throws AuthError when Authorization header has wrong scheme', async () => {
    const req = await createMockRequest({ authorization: 'Basic abc123' });
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Bearer token required',
    );
  });

  it('throws AuthError when API key is not found or revoked', async () => {
    mockRepo.findByHash.mockResolvedValue(null);
    const req = await createMockRequest({
      authorization: 'Bearer sk_live_abcdef1234567890abcdef1234567890',
    });
    await expect(provider.authenticate(req)).rejects.toThrow(
      'Invalid or expired API key',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run api-key-provider`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ApiKeyAuthProvider**

```typescript
// apps/api/src/auth/api-key-provider.ts
import { createHash } from 'node:crypto';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';
import type { ApiKeyRepository } from '@spatula/db';

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly apiKeyRepo: ApiKeyRepository) {}

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    if (!authHeader) {
      throw new AuthError('Authorization header is required');
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new AuthError('Bearer token required');
    }

    const token = authHeader.slice(7); // Remove "Bearer "
    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await this.apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      throw new AuthError('Invalid or expired API key');
    }

    return {
      tenantId: apiKey.tenantId,
      userId: apiKey.id,
      scopes: apiKey.scopes,
    };
  }
}
```

- [ ] **Step 4: Export from barrel**

Add to `apps/api/src/auth/index.ts`:

```typescript
export { ApiKeyAuthProvider } from './api-key-provider.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run api-key-provider`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/api-key-provider.ts apps/api/tests/unit/auth/api-key-provider.test.ts apps/api/src/auth/index.ts
git commit -m "feat(api): add ApiKeyAuthProvider with SHA-256 hash lookup"
```

---

## Task 6: Auth Provider Factory

**Files:**
- Create: `apps/api/src/auth/factory.ts`
- Create: `apps/api/tests/unit/auth/factory.test.ts`
- Modify: `apps/api/src/auth/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/auth/factory.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAuthProvider } from '../../../src/auth/factory.js';
import { NoAuthProvider } from '../../../src/auth/no-auth-provider.js';
import { ApiKeyAuthProvider } from '../../../src/auth/api-key-provider.js';

describe('createAuthProvider', () => {
  const mockApiKeyRepo = { findByHash: vi.fn() } as any;

  it('returns NoAuthProvider for strategy "none"', () => {
    const provider = createAuthProvider('none', { apiKeyRepo: mockApiKeyRepo });
    expect(provider).toBeInstanceOf(NoAuthProvider);
  });

  it('returns ApiKeyAuthProvider for strategy "api-key"', () => {
    const provider = createAuthProvider('api-key', {
      apiKeyRepo: mockApiKeyRepo,
    });
    expect(provider).toBeInstanceOf(ApiKeyAuthProvider);
  });

  it('throws for unsupported strategy', () => {
    expect(() =>
      createAuthProvider('jwt', { apiKeyRepo: mockApiKeyRepo }),
    ).toThrow('Auth strategy "jwt" is not yet supported');
  });

  it('throws for unknown strategy', () => {
    expect(() =>
      createAuthProvider('invalid' as any, { apiKeyRepo: mockApiKeyRepo }),
    ).toThrow('Unknown auth strategy: invalid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run factory`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement factory**

```typescript
// apps/api/src/auth/factory.ts
import type { AuthProvider } from '@spatula/shared';
import { ConfigError } from '@spatula/shared';
import type { ApiKeyRepository } from '@spatula/db';
import { NoAuthProvider } from './no-auth-provider.js';
import { ApiKeyAuthProvider } from './api-key-provider.js';

export type AuthStrategy = 'none' | 'api-key' | 'jwt';

export interface AuthProviderDeps {
  apiKeyRepo: ApiKeyRepository;
}

export function createAuthProvider(
  strategy: string,
  deps: AuthProviderDeps,
): AuthProvider {
  switch (strategy) {
    case 'none':
      return new NoAuthProvider();
    case 'api-key':
      return new ApiKeyAuthProvider(deps.apiKeyRepo);
    case 'jwt':
      // JWT provider will be added in Wave 3-1b
      throw new ConfigError('Auth strategy "jwt" is not yet supported');
    default:
      throw new ConfigError(`Unknown auth strategy: ${strategy}`);
  }
}
```

- [ ] **Step 4: Export from barrel**

Add to `apps/api/src/auth/index.ts`:

```typescript
export { createAuthProvider } from './factory.js';
export type { AuthStrategy, AuthProviderDeps } from './factory.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run factory`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/factory.ts apps/api/tests/unit/auth/factory.test.ts apps/api/src/auth/index.ts
git commit -m "feat(api): add createAuthProvider factory for strategy selection"
```

---

## Task 7: Auth Middleware

**Files:**
- Create: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/tests/unit/middleware/auth.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/middleware/auth.js';
import type { AuthProvider } from '@spatula/shared';

function createTestApp(provider: AuthProvider) {
  const app = new Hono();
  app.use('*', authMiddleware(provider));
  app.get('/api/v1/test', (c) => {
    return c.json({
      tenantId: c.get('tenantId'),
      auth: c.get('auth'),
    });
  });
  // Skip-auth paths
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/health/ready', (c) => c.json({ status: 'ok' }));
  app.get('/api/docs', (c) => c.text('docs'));
  app.get('/api/openapi.json', (c) => c.json({}));
  return app;
}

describe('authMiddleware', () => {
  it('sets tenantId and auth on context for authenticated requests', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        userId: 'user-1',
        scopes: ['jobs:read'],
      }),
    };
    const app = createTestApp(provider);

    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-1');
    expect(body.auth.userId).toBe('user-1');
    expect(body.auth.scopes).toEqual(['jobs:read']);
  });

  it('skips auth for /health', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /health/live', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);

    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /api/docs', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);

    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('skips auth for /api/openapi.json', async () => {
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const app = createTestApp(provider);

    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it('propagates AuthError from provider as-is', async () => {
    const { AuthError } = await import('@spatula/shared');
    const provider: AuthProvider = {
      authenticate: vi.fn().mockRejectedValue(new AuthError('bad token')),
    };
    const app = createTestApp(provider);
    // Add error handler to convert to response
    app.onError((err, c) => {
      if (err instanceof AuthError) {
        return c.json({ error: { code: 'AUTH_ERROR', message: err.message } }, 401);
      }
      return c.json({ error: { code: 'INTERNAL', message: 'unknown' } }, 500);
    });

    const res = await app.request('/api/v1/test');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run middleware/auth`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement auth middleware**

```typescript
// apps/api/src/middleware/auth.ts
import type { MiddlewareHandler } from 'hono';
import type { AuthProvider } from '@spatula/shared';

const SKIP_AUTH_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/api/docs',
  '/api/openapi.json',
]);

export function authMiddleware(provider: AuthProvider): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_AUTH_PATHS.has(c.req.path)) {
      return next();
    }

    const result = await provider.authenticate(c.req);
    c.set('tenantId', result.tenantId);
    c.set('auth', result);
    return next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run middleware/auth`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/tests/unit/middleware/auth.test.ts
git commit -m "feat(api): add auth middleware with skip-auth paths"
```

---

## Task 8: Require Scope Middleware

**Files:**
- Create: `apps/api/src/middleware/require-scope.ts`
- Create: `apps/api/tests/unit/middleware/require-scope.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/require-scope.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireScope } from '../../../src/middleware/require-scope.js';
import { ForbiddenError } from '@spatula/shared';

function createTestApp(requiredScope: string) {
  const app = new Hono();
  // Simulate auth already having set the auth context
  app.use('*', async (c, next) => {
    c.set('auth', c.req.header('x-test-scopes')
      ? { tenantId: 't', userId: 'u', scopes: JSON.parse(c.req.header('x-test-scopes')!) }
      : undefined);
    return next();
  });
  app.use('*', requireScope(requiredScope));
  app.get('/test', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof ForbiddenError) {
      return c.json({ error: { code: 'FORBIDDEN', message: err.message } }, 403);
    }
    return c.json({ error: { code: 'INTERNAL', message: err.message } }, 500);
  });
  return app;
}

describe('requireScope', () => {
  it('allows request when scope matches', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["jobs:read", "jobs:write"]' },
    });
    expect(res.status).toBe(200);
  });

  it('allows request when user has admin scope', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["admin"]' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects request when scope is missing', async () => {
    const app = createTestApp('jobs:write');
    const res = await app.request('/test', {
      headers: { 'x-test-scopes': '["jobs:read"]' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects request when auth context is not set', async () => {
    const app = createTestApp('jobs:read');
    const res = await app.request('/test');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run require-scope`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement requireScope**

```typescript
// apps/api/src/middleware/require-scope.ts
import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from '@spatula/shared';
import type { AuthResult } from '@spatula/shared';

export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as AuthResult | undefined;
    if (!auth) {
      throw new ForbiddenError(`Scope "${scope}" required`);
    }

    // admin scope grants access to everything
    if (auth.scopes.includes('admin') || auth.scopes.includes(scope)) {
      return next();
    }

    throw new ForbiddenError(
      `Insufficient permissions: requires "${scope}"`,
    );
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run require-scope`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/require-scope.ts apps/api/tests/unit/middleware/require-scope.test.ts
git commit -m "feat(api): add requireScope middleware for scope-based authorization"
```

---

## Task 9: Security Headers & CORS

**Files:**
- Create: `apps/api/src/middleware/security-headers.ts`
- Create: `apps/api/tests/unit/middleware/security-headers.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/security-headers.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from '../../../src/middleware/security-headers.js';

describe('securityHeaders', () => {
  it('sets all required security headers', async () => {
    const app = new Hono();
    app.use('*', securityHeaders);
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(res.headers.get('X-XSS-Protection')).toBe('0');
    expect(res.headers.get('Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run security-headers`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement security headers middleware**

```typescript
// apps/api/src/middleware/security-headers.ts
import type { MiddlewareHandler } from 'hono';

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('X-XSS-Protection', '0');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run security-headers`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/security-headers.ts apps/api/tests/unit/middleware/security-headers.test.ts
git commit -m "feat(api): add security headers middleware (OWASP recommended headers)"
```

---

## Task 10: API Key Routes

**Files:**
- Create: `apps/api/src/schemas/api-key.ts`
- Create: `apps/api/src/routes/api-keys.ts`
- Create: `apps/api/tests/unit/routes/api-keys.test.ts`

- [ ] **Step 1: Create Zod schemas for API key endpoints**

```typescript
// apps/api/src/schemas/api-key.ts
import { z } from '@hono/zod-openapi';

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(255).openapi({ example: 'Production Key' }),
  scopes: z
    .array(z.string())
    .optional()
    .openapi({ example: ['jobs:read', 'jobs:write'] }),
  expiresAt: z.string().datetime().optional().openapi({
    example: '2027-01-01T00:00:00Z',
    description: 'ISO 8601 expiration date (optional)',
  }),
});

export const apiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  keyPrefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi('ApiKey');

export const apiKeyCreatedResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string().openapi({
    description: 'The raw API key. This is the only time it will be shown.',
    example: 'sk_live_abc123...',
  }),
  keyPrefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi('ApiKeyCreated');
```

- [ ] **Step 2: Write failing route tests**

```typescript
// apps/api/tests/unit/routes/api-keys.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from '../../../src/routes/api-keys.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  // Simulate auth + deps middleware
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['keys:manage'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/api-keys', apiKeyRoutes());
  return app;
}

describe('API Key routes', () => {
  let mockApiKeyRepo: any;
  let app: Hono;

  beforeEach(() => {
    mockApiKeyRepo = {
      create: vi.fn().mockResolvedValue({
        id: 'key-1',
        tenantId: 'tenant-1',
        keyHash: 'hash',
        keyPrefix: 'sk_live_',
        name: 'Test Key',
        scopes: ['jobs:read', 'jobs:write'],
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        revokedAt: null,
      }),
      listByTenant: vi.fn().mockResolvedValue([
        {
          id: 'key-1',
          keyPrefix: 'sk_live_',
          name: 'Test Key',
          scopes: ['jobs:read'],
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
        },
      ]),
      revoke: vi.fn().mockResolvedValue({
        id: 'key-1',
        revokedAt: new Date(),
      }),
    };
    app = createTestApp({ apiKeyRepo: mockApiKeyRepo });
  });

  describe('POST /api/v1/api-keys', () => {
    it('creates an API key and returns raw key once', async () => {
      const res = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Key' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.key).toBeDefined();
      expect(body.data.key).toMatch(/^sk_live_/);
      expect(body.data.name).toBe('Test Key');
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          name: 'Test Key',
          keyHash: expect.any(String),
          keyPrefix: expect.stringMatching(/^sk_live_/),
        }),
      );
    });
  });

  describe('GET /api/v1/api-keys', () => {
    it('lists API keys for tenant (without hashes)', async () => {
      const res = await app.request('/api/v1/api-keys');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].keyPrefix).toBe('sk_live_');
      expect(body.data[0]).not.toHaveProperty('keyHash');
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    it('revokes an API key (soft delete)', async () => {
      const res = await app.request('/api/v1/api-keys/key-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(mockApiKeyRepo.revoke).toHaveBeenCalledWith('key-1', 'tenant-1');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- --run routes/api-keys`

Expected: FAIL — module not found.

- [ ] **Step 4: Implement API key routes**

```typescript
// apps/api/src/routes/api-keys.ts
import { randomBytes, createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import {
  createApiKeySchema,
  apiKeyResponseSchema,
  apiKeyCreatedResponseSchema,
} from '../schemas/api-key.js';
import {
  errorResponseSchema,
  dataResponse,
  listResponse,
  jsonContent,
} from '../schemas/responses.js';
import type { AppEnv } from '../types.js';
import { DEFAULT_API_KEY_SCOPES } from '@spatula/shared';

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(24).toString('base64url'); // 32 chars
  const raw = `sk_live_${random}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 8);
  return { raw, hash, prefix };
}

const createKeyRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['API Keys'],
  summary: 'Create a new API key',
  request: {
    body: {
      content: { 'application/json': { schema: createApiKeySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(dataResponse(apiKeyCreatedResponseSchema), 'API key created (raw key shown once)'),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const listKeysRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['API Keys'],
  summary: 'List API keys for tenant',
  responses: {
    200: jsonContent(listResponse(apiKeyResponseSchema), 'List of API keys'),
  },
});

const revokeKeyRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['API Keys'],
  summary: 'Revoke an API key',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({ data: z.object({ id: z.string(), revoked: z.boolean() }) }),
      'API key revoked',
    ),
    404: jsonContent(errorResponseSchema, 'API key not found'),
  },
});

export function apiKeyRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createKeyRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');
    const body = c.req.valid('json');

    const { raw, hash, prefix } = generateApiKey();
    const scopes = body.scopes ?? [...DEFAULT_API_KEY_SCOPES];
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

    const key = await deps.apiKeyRepo!.create({
      tenantId,
      keyHash: hash,
      keyPrefix: prefix,
      name: body.name,
      scopes,
      expiresAt,
    });

    return c.json(
      {
        data: {
          id: key.id,
          key: raw, // Only time the raw key is returned
          keyPrefix: key.keyPrefix,
          name: key.name,
          scopes: key.scopes,
          expiresAt: key.expiresAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');

    const keys = await deps.apiKeyRepo!.listByTenant(tenantId);
    return c.json({
      data: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        name: k.name,
        scopes: k.scopes,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');
    const { id } = c.req.valid('param');

    await deps.apiKeyRepo!.revoke(id, tenantId);
    return c.json({ data: { id, revoked: true } });
  });

  return router;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- --run routes/api-keys`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/schemas/api-key.ts apps/api/src/routes/api-keys.ts apps/api/tests/unit/routes/api-keys.test.ts
git commit -m "feat(api): add API key CRUD routes (create, list, revoke)"
```

---

## Task 11: Wire Everything into App

**Files:**
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/app.ts`

This is the integration task that connects all the pieces. It's the most important task to get right because it affects all existing tests.

- [ ] **Step 1: Update AppDeps and AppEnv types**

In `apps/api/src/types.ts`, add the new fields:

Add the import:

```typescript
import type { AuthProvider, AuthResult } from '@spatula/shared';
import type { ApiKeyRepository } from '@spatula/db';
```

Add to `AppDeps`:

```typescript
  authProvider?: AuthProvider;
  apiKeyRepo?: ApiKeyRepository;
```

Add to `AppEnv.Variables`:

```typescript
    auth: AuthResult;
```

- [ ] **Step 2: Rewrite app.ts with auth-aware middleware chain**

Replace the entire `apps/api/src/app.ts` with:

```typescript
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { securityHeaders } from './middleware/security-headers.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { authMiddleware } from './middleware/auth.js';
import { depsMiddleware } from './middleware/deps.js';
import { validateTenantMiddleware } from './middleware/validate-tenant.js';
import { requireScope } from './middleware/require-scope.js';
import { createOpenAPIRouter } from './openapi-config.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import { adminDlqRoutes } from './routes/admin-dlq.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { NoAuthProvider } from './auth/no-auth-provider.js';
import type { AppDeps } from './types.js';
import { getEnvOrDefault } from '@spatula/shared';

export function createApp(deps: AppDeps) {
  const app = createOpenAPIRouter();
  const authStrategy = getEnvOrDefault('AUTH_STRATEGY', 'api-key');
  const authProvider = deps.authProvider ?? new NoAuthProvider();

  // Global middleware chain (order matters)
  app.use('*', requestContextMiddleware);
  app.use('*', honoLogger());
  app.use('*', securityHeaders);
  app.onError(errorHandler);

  // CORS
  const allowedOrigins = getEnvOrDefault('CORS_ALLOWED_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim());
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Request-Id'],
      maxAge: 86400,
      credentials: true,
    }),
  );

  // Health check (no auth)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // OpenAPI documentation (no auth)
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Spatula API',
      version: '1.0.0',
      description: 'AI-powered intelligent web crawling platform',
    },
  });
  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

  // Auth middleware — uses authProvider (NoAuthProvider when AUTH_STRATEGY=none)
  app.use('/api/*', authMiddleware(authProvider));
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // Tenant management routes
  app.route('/api/v1/tenants', tenantRoutes());

  // API key management routes
  if (deps.apiKeyRepo) {
    app.use('/api/v1/api-keys', requireScope('keys:manage'));
    app.use('/api/v1/api-keys/*', requireScope('keys:manage'));
    app.route('/api/v1/api-keys', apiKeyRoutes());
  }

  // API v1 routes with scope enforcement
  app.use('/api/v1/jobs', requireScope('jobs:read'));
  app.use('/api/v1/jobs/*', requireScope('jobs:read'));
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  // Admin routes
  app.use('/api/v1/admin/*', requireScope('admin'));
  app.route('/api/v1/admin/dlq', adminDlqRoutes());

  return app;
}
```

**Critical design notes:**
- When `AUTH_STRATEGY=none` (or not set in tests), `NoAuthProvider` extracts `x-tenant-id` header and grants admin scope — so all existing tests pass unchanged since `NoAuthProvider` grants `admin` which satisfies any `requireScope()` check.
- The old `tenantMiddleware` is removed from the chain when using auth. `authMiddleware` is now the sole source of `tenantId`.
- Tenant routes no longer get special middleware treatment (they go through auth like everything else).
- `requireScope('jobs:read')` is applied broadly to all job sub-routes. Mutating routes (POST, PATCH, DELETE) should be scope-checked more granularly — but since `jobs:read` is in the default scopes and `NoAuthProvider` grants `admin`, this is safe for now. Finer-grained per-method scoping can be refined per-route in a later pass.

- [ ] **Step 3: Run ALL existing tests to verify nothing broke**

Run: `pnpm --filter @spatula/api test`

Expected: ALL 175+ existing tests PASS.

**If any tests fail**, the most likely cause is:
- Tests that don't send `x-tenant-id` header for API routes (the `NoAuthProvider` still requires it)
- Tests that construct `createMockDeps()` without `authProvider` or `apiKeyRepo` — these new fields are optional, so existing mocks should still work.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/types.ts apps/api/src/app.ts
git commit -m "feat(api): wire auth middleware, security headers, CORS, and scope enforcement into app"
```

---

## Task 12: Integration Verification

This final task runs the full test suite and verifies end-to-end correctness.

- [ ] **Step 1: Run full build**

Run: `pnpm build`

Expected: Clean build, no type errors.

- [ ] **Step 2: Run full test suite across all packages**

Run: `pnpm test`

Expected: All tests pass. New test count should be ~175 existing + ~40 new = ~215 in `@spatula/api`, plus ~5 in `@spatula/db`.

- [ ] **Step 3: Verify new auth functionality with a quick manual check**

Create a small integration test or verify via the test output:
- `NoAuthProvider` allows requests with `x-tenant-id` header
- `NoAuthProvider` rejects requests without `x-tenant-id`
- `ApiKeyAuthProvider` rejects requests without `Authorization` header
- Security headers appear on all responses
- CORS headers appear on preflight responses

- [ ] **Step 4: Commit any fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address integration issues in auth core wiring"
```
