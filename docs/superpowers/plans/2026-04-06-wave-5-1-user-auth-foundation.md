# Wave 5-1: User & Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish user-tenant relationships, extend JWT auth for multi-tenant users, raise entity pagination limit for bulk pulls, and install Stripe SDK.

**Architecture:** The core change is in the auth middleware: instead of extracting `tenant_id` directly from JWT claims, JWT users are resolved via a `user_tenants` lookup table. Users with one tenant auto-select it; users with multiple tenants must pass `X-Tenant-Id` header. API key and no-auth paths are unchanged. New users auto-get a Free-tier tenant on first API call.

**Tech Stack:** Drizzle ORM (Postgres schema + migrations), Vitest, Hono middleware, Stripe SDK

**Spec reference:** `docs/superpowers/specs/2026-04-06-wave-5-decomposition-design.md` § 5-1

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/db/src/schema/user-tenants.ts` | Drizzle schema for user_tenants table |
| Create | `packages/db/src/repositories/user-tenant-repository.ts` | CRUD for user-tenant relationships |
| Create | `packages/db/tests/unit/repositories/user-tenant-repository.test.ts` | Repository tests |
| Create | `apps/api/tests/unit/middleware/jwt-tenant-resolution.test.ts` | Auth middleware tenant resolution tests |
| Modify | `packages/db/src/schema/index.ts` | Re-export user-tenants schema |
| Modify | `packages/db/src/index.ts` | Export UserTenantRepository |
| Modify | `packages/shared/src/auth/types.ts` | Add `strategy` field to AuthResult |
| Modify | `apps/api/src/auth/jwt-provider.ts` | Stop requiring tenant_id claim, extract user_id from sub |
| Modify | `apps/api/src/auth/no-auth-provider.ts` | Add strategy: 'none' to AuthResult |
| Modify | `apps/api/src/auth/api-key-provider.ts` | Add strategy: 'api-key' to AuthResult |
| Modify | `apps/api/src/middleware/auth.ts` | Add JWT user→tenant resolution branching |
| Modify | `apps/api/src/types.ts` | Add userTenantRepo to AppDeps |
| Modify | `apps/api/src/app.ts` | Wire userTenantRepo, pass to auth middleware |
| Modify | `apps/api/src/schemas/pagination.ts` | Raise limit max from 100 to 500 |

---

### Task 1: user_tenants Drizzle Schema + Migration

**Files:**
- Create: `packages/db/src/schema/user-tenants.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the user_tenants schema file**

`packages/db/src/schema/user-tenants.ts`:

```typescript
import { pgTable, text, uuid, varchar, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const userTenants = pgTable(
  'user_tenants',
  {
    userId: text('user_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index('idx_user_tenants_user').on(table.userId),
    uniqueIndex('idx_user_tenants_owner').on(table.userId).where(sql`role = 'owner'`),
  ],
);
```

- [ ] **Step 2: Add re-export to schema index**

In `packages/db/src/schema/index.ts`, add at the end:

```typescript
export * from './user-tenants.js';
```

- [ ] **Step 3: Generate migration**

```bash
cd packages/db && npx drizzle-kit generate
```

This will create `drizzle/0008_*.sql` with the `CREATE TABLE user_tenants` statement. Verify the migration file contains the primary key, indexes, and unique partial index.

- [ ] **Step 4: Run migration against test database**

```bash
cd packages/db && DATABASE_URL=$TEST_DATABASE_URL npx drizzle-kit push
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/user-tenants.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): add user_tenants schema and migration"
```

---

### Task 2: UserTenantRepository

**Files:**
- Create: `packages/db/src/repositories/user-tenant-repository.ts`
- Create: `packages/db/tests/unit/repositories/user-tenant-repository.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/db/tests/unit/repositories/user-tenant-repository.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { UserTenantRepository } from '../../../src/repositories/user-tenant-repository.js';

function createMockDb() {
  const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
    _mocks: { mockValues, mockOnConflictDoNothing, mockWhere, mockFrom, mockSet, mockDeleteWhere },
  };
  return db;
}

describe('UserTenantRepository', () => {
  it('creates a user-tenant relationship with onConflictDoNothing', async () => {
    const db = createMockDb();
    const repo = new UserTenantRepository(db as any);
    await repo.create('auth0|user1', 'tenant-1', 'owner');
    expect(db.insert).toHaveBeenCalled();
    expect(db._mocks.mockOnConflictDoNothing).toHaveBeenCalled();
  });

  it('findByUserId returns matching entries', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([
      { tenantId: 'tenant-1', role: 'owner', createdAt: new Date() },
      { tenantId: 'tenant-2', role: 'member', createdAt: new Date() },
    ]);
    const repo = new UserTenantRepository(db as any);
    const result = await repo.findByUserId('auth0|user1');
    expect(result).toHaveLength(2);
    expect(result[0].tenantId).toBe('tenant-1');
    expect(result[1].role).toBe('member');
  });

  it('findByUserId returns empty array for unknown user', async () => {
    const db = createMockDb();
    const repo = new UserTenantRepository(db as any);
    const result = await repo.findByUserId('unknown');
    expect(result).toHaveLength(0);
  });

  it('findByTenantId returns matching entries', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([
      { userId: 'auth0|user1', role: 'owner', createdAt: new Date() },
    ]);
    const repo = new UserTenantRepository(db as any);
    const result = await repo.findByTenantId('tenant-1');
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('auth0|user1');
  });

  it('updateRole calls update with correct params', async () => {
    const db = createMockDb();
    const repo = new UserTenantRepository(db as any);
    await repo.updateRole('auth0|user1', 'tenant-1', 'admin');
    expect(db.update).toHaveBeenCalled();
  });

  it('remove calls delete', async () => {
    const db = createMockDb();
    const repo = new UserTenantRepository(db as any);
    await repo.remove('auth0|user1', 'tenant-1');
    expect(db.delete).toHaveBeenCalled();
  });

  it('isAdmin returns true for owner role', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([{ role: 'owner' }]);
    const repo = new UserTenantRepository(db as any);
    expect(await repo.isAdmin('auth0|user1', 'tenant-1')).toBe(true);
  });

  it('isAdmin returns true for admin role', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([{ role: 'admin' }]);
    const repo = new UserTenantRepository(db as any);
    expect(await repo.isAdmin('auth0|user1', 'tenant-1')).toBe(true);
  });

  it('isAdmin returns false for member role', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([{ role: 'member' }]);
    const repo = new UserTenantRepository(db as any);
    expect(await repo.isAdmin('auth0|user1', 'tenant-1')).toBe(false);
  });

  it('isAdmin returns false for unknown user', async () => {
    const db = createMockDb();
    const repo = new UserTenantRepository(db as any);
    expect(await repo.isAdmin('unknown', 'tenant-1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @spatula/db exec vitest run tests/unit/repositories/user-tenant-repository.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement UserTenantRepository**

`packages/db/src/repositories/user-tenant-repository.ts`:

```typescript
import { eq, and } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { userTenants } from '../schema/user-tenants.js';
import type { Database } from '../connection.js';

const logger = createLogger('user-tenant-repository');

export interface UserTenantEntry {
  tenantId: string;
  role: string;
  createdAt: Date;
}

export interface TenantUserEntry {
  userId: string;
  role: string;
  createdAt: Date;
}

export class UserTenantRepository {
  constructor(private readonly db: Database) {}

  async create(userId: string, tenantId: string, role: string): Promise<void> {
    await this.db
      .insert(userTenants)
      .values({ userId, tenantId, role })
      .onConflictDoNothing();
  }

  async findByUserId(userId: string): Promise<UserTenantEntry[]> {
    const rows = await this.db
      .select({
        tenantId: userTenants.tenantId,
        role: userTenants.role,
        createdAt: userTenants.createdAt,
      })
      .from(userTenants)
      .where(eq(userTenants.userId, userId));
    return rows;
  }

  async findByTenantId(tenantId: string): Promise<TenantUserEntry[]> {
    const rows = await this.db
      .select({
        userId: userTenants.userId,
        role: userTenants.role,
        createdAt: userTenants.createdAt,
      })
      .from(userTenants)
      .where(eq(userTenants.tenantId, tenantId));
    return rows;
  }

  async updateRole(userId: string, tenantId: string, role: string): Promise<void> {
    await this.db
      .update(userTenants)
      .set({ role })
      .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
  }

  async remove(userId: string, tenantId: string): Promise<void> {
    await this.db
      .delete(userTenants)
      .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
  }

  async isAdmin(userId: string, tenantId: string): Promise<boolean> {
    const rows = await this.db
      .select({ role: userTenants.role })
      .from(userTenants)
      .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
    if (rows.length === 0) return false;
    return rows[0].role === 'owner' || rows[0].role === 'admin';
  }
}
```

- [ ] **Step 4: Export from packages/db/src/index.ts**

Add to `packages/db/src/index.ts`:

```typescript
export { UserTenantRepository } from './repositories/user-tenant-repository.js';
export type { UserTenantEntry, TenantUserEntry } from './repositories/user-tenant-repository.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @spatula/db exec vitest run tests/unit/repositories/user-tenant-repository.test.ts
```

Expected: 10 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/user-tenant-repository.ts packages/db/tests/unit/repositories/user-tenant-repository.test.ts packages/db/src/index.ts
git commit -m "feat(db): add UserTenantRepository with CRUD operations"
```

---

### Task 3: AuthResult Strategy Extension

**Files:**
- Modify: `packages/shared/src/auth/types.ts`
- Modify: `apps/api/src/auth/jwt-provider.ts`
- Modify: `apps/api/src/auth/no-auth-provider.ts`
- Modify: `apps/api/src/auth/api-key-provider.ts`

- [ ] **Step 1: Add `strategy` field to AuthResult**

In `packages/shared/src/auth/types.ts`, update the interface:

```typescript
export interface AuthResult {
  tenantId: string;
  userId: string;
  scopes: string[];
  strategy: 'none' | 'api-key' | 'jwt';
}
```

- [ ] **Step 2: Update NoAuthProvider to include strategy**

In `apps/api/src/auth/no-auth-provider.ts`, in the return statement (around line 18-22), add `strategy: 'none'`:

```typescript
return {
  tenantId,
  userId: 'anonymous',
  scopes: ['admin'],
  strategy: 'none',
};
```

- [ ] **Step 3: Update ApiKeyAuthProvider to include strategy**

In `apps/api/src/auth/api-key-provider.ts`, in the return statement (around line 30-34), add `strategy: 'api-key'`:

```typescript
return {
  tenantId: apiKey.tenantId,
  userId: apiKey.id,
  scopes: apiKey.scopes,
  strategy: 'api-key',
};
```

- [ ] **Step 4: Update JwtAuthProvider — stop requiring tenant_id, add strategy**

In `apps/api/src/auth/jwt-provider.ts`, replace the tenant_id extraction logic (around lines 42-48). The JWT provider should no longer require or extract `tenant_id`. Instead, it returns a placeholder `tenantId` that will be resolved by the auth middleware:

```typescript
// Old: const tenantId = payload.tenant_id as string | undefined;
// Old: if (!tenantId) throw new AuthenticationError('...');

return {
  tenantId: '', // Will be resolved by auth middleware via user_tenants lookup
  userId: payload.sub ?? 'unknown',
  scopes: (payload.scopes as string[] | undefined) ?? [],
  strategy: 'jwt',
};
```

Remove the `tenant_id` claim requirement and the error throw for missing tenant_id.

- [ ] **Step 5: Run existing auth tests to check for breakage**

```bash
pnpm --filter @spatula/api exec vitest run tests/ --grep "auth"
```

Fix any tests that assert on the old AuthResult shape (add `strategy` field to expected values).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/auth/types.ts apps/api/src/auth/jwt-provider.ts apps/api/src/auth/no-auth-provider.ts apps/api/src/auth/api-key-provider.ts
git commit -m "feat(auth): add strategy field to AuthResult, stop requiring tenant_id in JWT"
```

---

### Task 4: JWT Tenant Resolution in Auth Middleware

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/unit/middleware/jwt-tenant-resolution.test.ts`

This is the core change. After JWT authentication returns `strategy: 'jwt'` with an empty `tenantId`, the middleware resolves the user's tenant(s) via `UserTenantRepository`.

- [ ] **Step 1: Add userTenantRepo to AppDeps**

In `apps/api/src/types.ts`, add to the `AppDeps` interface:

```typescript
import { UserTenantRepository } from '@spatula/db';
// ... existing imports ...

export interface AppDeps {
  // ... existing fields ...
  userTenantRepo?: UserTenantRepository;
}
```

- [ ] **Step 2: Write failing tests for JWT tenant resolution**

`apps/api/tests/unit/middleware/jwt-tenant-resolution.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/middleware/auth.js';
import type { AuthProvider } from '@spatula/shared';

// Mock JWT provider that returns strategy: 'jwt' with no tenantId
function createJwtProvider(userId = 'auth0|user1'): AuthProvider {
  return {
    authenticate: vi.fn().mockResolvedValue({
      tenantId: '',
      userId,
      scopes: ['jobs:read'],
      strategy: 'jwt',
    }),
  };
}

// Mock API key provider that returns strategy: 'api-key' with tenantId already set
function createApiKeyProvider(): AuthProvider {
  return {
    authenticate: vi.fn().mockResolvedValue({
      tenantId: 'tenant-from-key',
      userId: 'key-1',
      scopes: ['jobs:read'],
      strategy: 'api-key',
    }),
  };
}

function createMockUserTenantRepo(entries: { tenantId: string; role: string }[] = []) {
  return {
    findByUserId: vi.fn().mockResolvedValue(entries.map((e) => ({ ...e, createdAt: new Date() }))),
    create: vi.fn().mockResolvedValue(undefined),
    findByTenantId: vi.fn(),
    updateRole: vi.fn(),
    remove: vi.fn(),
    isAdmin: vi.fn(),
  };
}

function createMockTenantRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'auto-tenant-1', name: 'New User' }),
    findById: vi.fn(),
    update: vi.fn(),
    getQuotas: vi.fn(),
  };
}

function createTestApp(
  provider: AuthProvider,
  userTenantRepo?: any,
  tenantRepo?: any,
) {
  const app = new Hono();
  app.use('*', authMiddleware(provider, undefined, userTenantRepo, tenantRepo));
  app.get('/api/v1/test', (c) => {
    return c.json({ tenantId: c.get('tenantId'), auth: c.get('auth') });
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}

describe('JWT tenant resolution', () => {
  it('auto-selects tenant when user has exactly one', async () => {
    const utRepo = createMockUserTenantRepo([{ tenantId: 'tenant-1', role: 'owner' }]);
    const app = createTestApp(createJwtProvider(), utRepo, createMockTenantRepo());
    const res = await app.request('/api/v1/test', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-1');
  });

  it('selects tenant from X-Tenant-Id when user has multiple', async () => {
    const utRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-1', role: 'owner' },
      { tenantId: 'tenant-2', role: 'member' },
    ]);
    const app = createTestApp(createJwtProvider(), utRepo, createMockTenantRepo());
    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer tok', 'x-tenant-id': 'tenant-2' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-2');
  });

  it('returns 400 when multi-tenant user omits X-Tenant-Id', async () => {
    const utRepo = createMockUserTenantRepo([
      { tenantId: 'tenant-1', role: 'owner' },
      { tenantId: 'tenant-2', role: 'member' },
    ]);
    const app = createTestApp(createJwtProvider(), utRepo, createMockTenantRepo());
    const res = await app.request('/api/v1/test', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT_REQUIRED');
  });

  it('returns 403 when user specifies tenant they do not belong to', async () => {
    const utRepo = createMockUserTenantRepo([{ tenantId: 'tenant-1', role: 'owner' }]);
    const app = createTestApp(createJwtProvider(), utRepo, createMockTenantRepo());
    const res = await app.request('/api/v1/test', {
      headers: { authorization: 'Bearer tok', 'x-tenant-id': 'wrong-tenant' },
    });
    expect(res.status).toBe(403);
  });

  it('auto-creates Free tenant for new JWT user with 0 tenants', async () => {
    const utRepo = createMockUserTenantRepo([]); // 0 tenants
    const tRepo = createMockTenantRepo();
    const app = createTestApp(createJwtProvider(), utRepo, tRepo);
    const res = await app.request('/api/v1/test', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    expect(tRepo.create).toHaveBeenCalled();
    expect(utRepo.create).toHaveBeenCalledWith('auth0|user1', 'auto-tenant-1', 'owner');
    const body = await res.json();
    expect(body.tenantId).toBe('auto-tenant-1');
  });

  it('does not modify tenantId for api-key strategy', async () => {
    const app = createTestApp(createApiKeyProvider());
    const res = await app.request('/api/v1/test', { headers: { authorization: 'Bearer key' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-from-key');
  });
});
```

- [ ] **Step 3: Implement JWT tenant resolution in auth middleware**

Update `authMiddleware` signature to accept repos via closure (since deps middleware runs AFTER auth):

```typescript
import type { UserTenantRepository } from '@spatula/db';
import type { TenantRepository } from '@spatula/db';

export function authMiddleware(
  provider: AuthProvider,
  auditLogger?: AuditLogger,
  userTenantRepo?: UserTenantRepository,
  tenantRepo?: TenantRepository,
): MiddlewareHandler<AppEnv> {
```

Inside the middleware, after `const result = await provider.authenticate(c.req)`, add JWT branching BEFORE the existing `c.set('tenantId', ...)` line. Use the closure-captured repos, NOT `c.get('deps')`:

```typescript
const result = await provider.authenticate(c.req);

// JWT path: resolve user → tenant(s) via user_tenants table
// Note: api-key and none strategies already have tenantId resolved — skip them.
if (result.strategy === 'jwt' && userTenantRepo && tenantRepo) {
  let entries = await userTenantRepo.findByUserId(result.userId);

  if (entries.length === 0) {
    // Auto-create Free tenant for new user (spec deliverable 5 supersedes deliverable 4's 403)
    const tenant = await tenantRepo.create({
      name: result.userId, // Implementer: extract JWT `name` or `email` claim if available
    });
    await userTenantRepo.create(result.userId, tenant.id, 'owner');
    entries = [{ tenantId: tenant.id, role: 'owner', createdAt: new Date() }];
  }

  let resolvedTenantId: string;

  if (entries.length === 1) {
    resolvedTenantId = entries[0].tenantId;
  } else {
    // Multiple tenants — require X-Tenant-Id header
    const headerTenantId = c.req.header('x-tenant-id');
    if (!headerTenantId) {
      return c.json({
        error: {
          code: 'TENANT_REQUIRED',
          message: 'User belongs to multiple tenants. Set X-Tenant-Id header.',
          tenants: entries.map((ut) => ({ tenantId: ut.tenantId, role: ut.role })),
        },
      }, 400);
    }
    const match = entries.find((ut) => ut.tenantId === headerTenantId);
    if (!match) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'User does not belong to the specified tenant' } }, 403);
    }
    resolvedTenantId = headerTenantId;
  }

  // Create new AuthResult with resolved tenantId (don't mutate original)
  const resolvedResult: AuthResult = { ...result, tenantId: resolvedTenantId };
  c.set('tenantId', resolvedResult.tenantId);
  c.set('auth', resolvedResult);

  // Audit log AFTER tenant resolution so tenantId is populated
  if (auditLogger) {
    auditLogger.log({ action: 'api.request', tenantId: resolvedResult.tenantId, userId: resolvedResult.userId });
  }

  await next();
  return;
}

// Non-JWT path: tenantId already resolved by provider
c.set('tenantId', result.tenantId);
c.set('auth', result);
// ... existing audit logging for non-JWT paths ...
```

Key decisions:
- Uses closure-captured `userTenantRepo` and `tenantRepo`, NOT `c.get('deps')` (deps middleware hasn't run yet)
- Creates new `AuthResult` object instead of mutating the original
- Audit logging fires AFTER tenant resolution for JWT path, so tenantId is correct
- Auto-tenant creation: per spec deliverable 5, auto-create with `owner` role (supersedes deliverable 4's 403 for 0 tenants)

- [ ] **Step 4: Wire userTenantRepo in app.ts**

In `apps/api/src/app.ts`, pass the `userTenantRepo` (which the caller constructs alongside other repos) to auth middleware:

```typescript
// Update auth middleware call (around line 95):
app.use('/api/*', authMiddleware(authProvider, deps.auditLogger, deps.userTenantRepo, deps.tenantRepo));
```

The `UserTenantRepository` is constructed in the server entrypoint (`apps/api/src/index.ts`) alongside other repos, from the same Drizzle `Database` instance, and passed into `deps`. This follows the existing pattern — all repos are constructed outside `createApp()` and injected via `AppDeps`.

The caller (entrypoint) creates it:
```typescript
import { UserTenantRepository } from '@spatula/db';
// ...
const userTenantRepo = new UserTenantRepository(database);
const deps: AppDeps = {
  // ... existing deps ...
  userTenantRepo,
};
```

- [ ] **Step 5: Run JWT resolution tests**

```bash
pnpm --filter @spatula/api exec vitest run tests/unit/middleware/jwt-tenant-resolution.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 6: Run full API test suite for regression**

```bash
pnpm --filter @spatula/api test
```

Expected: All existing tests PASS. Fix any that break due to the AuthResult `strategy` field addition.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/types.ts apps/api/src/app.ts apps/api/tests/unit/middleware/jwt-tenant-resolution.test.ts
git commit -m "feat(auth): JWT user→tenant resolution via user_tenants table"
```

---

### Task 5: Entity Pagination Limit Increase

**Files:**
- Modify: `apps/api/src/schemas/pagination.ts`

- [ ] **Step 1: Raise limit max from 100 to 500**

In `apps/api/src/schemas/pagination.ts`, change the transform on the `limit` field (line 9):

```typescript
// Old: .transform((v) => Math.min(v, 100))
.transform((v) => Math.min(v, 500))
```

- [ ] **Step 2: Run existing pagination tests**

```bash
pnpm --filter @spatula/api test
```

Expected: All PASS. If any test asserts `limit` is capped at 100, update the assertion to 500.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/pagination.ts
git commit -m "feat(api): raise entity pagination limit from 100 to 500 for bulk pull support"
```

---

### Task 6: Stripe SDK Installation

**Files:**
- Modify: `package.json` (root or apps/api)

- [ ] **Step 1: Install Stripe SDK**

```bash
pnpm add stripe --filter @spatula/api
```

The Stripe SDK is needed by the API server for billing endpoints (Wave 5-2) and by the queue package for the metering worker. Install in API first; queue can import it when needed.

- [ ] **Step 2: Verify installation**

```bash
node -e "require('stripe')" 2>/dev/null && echo "OK" || echo "FAIL"
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore: install Stripe SDK for billing integration"
```

---

## Execution Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | 3 | user_tenants schema + migration |
| 2 | 3 | UserTenantRepository with CRUD + tests |
| 3 | 4 | AuthResult strategy extension across all providers |
| 4 | 4 | JWT tenant resolution middleware + auto-creation + tests |
| 5 | 1 | Entity pagination limit 100→500 |
| 6 | 2 | Stripe SDK installation |
| **Total** | **17** | **6 commits** |
