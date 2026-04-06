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
    uniqueIndex('idx_user_tenants_owner').on(table.userId).where(`role = 'owner'`),
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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase } from '../../src/connection.js';
import { TenantRepository } from '../../src/repositories/tenant-repository.js';
import { UserTenantRepository } from '../../src/repositories/user-tenant-repository.js';
import type { Database } from '../../src/connection.js';

describe('UserTenantRepository', () => {
  let db: Database;
  let tenantRepo: TenantRepository;
  let repo: UserTenantRepository;
  let tenantId: string;
  let tenantId2: string;
  const userId = 'auth0|user123';
  const userId2 = 'auth0|user456';

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!);
    tenantRepo = new TenantRepository(db);
    repo = new UserTenantRepository(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    // Clean up and create fresh tenants
    await db.delete(require('../../src/schema/user-tenants.js').userTenants);
    const t1 = await tenantRepo.create({ name: 'Test Tenant 1' });
    const t2 = await tenantRepo.create({ name: 'Test Tenant 2' });
    tenantId = t1.id;
    tenantId2 = t2.id;
  });

  it('creates a user-tenant relationship', async () => {
    await repo.create(userId, tenantId, 'owner');
    const tenants = await repo.findByUserId(userId);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ tenantId, role: 'owner' });
  });

  it('finds all tenants for a user', async () => {
    await repo.create(userId, tenantId, 'owner');
    await repo.create(userId, tenantId2, 'member');
    const tenants = await repo.findByUserId(userId);
    expect(tenants).toHaveLength(2);
  });

  it('finds all users for a tenant', async () => {
    await repo.create(userId, tenantId, 'owner');
    await repo.create(userId2, tenantId, 'member');
    const users = await repo.findByTenantId(tenantId);
    expect(users).toHaveLength(2);
  });

  it('updates a role', async () => {
    await repo.create(userId, tenantId, 'member');
    await repo.updateRole(userId, tenantId, 'admin');
    const tenants = await repo.findByUserId(userId);
    expect(tenants[0].role).toBe('admin');
  });

  it('removes a user-tenant relationship', async () => {
    await repo.create(userId, tenantId, 'owner');
    await repo.remove(userId, tenantId);
    const tenants = await repo.findByUserId(userId);
    expect(tenants).toHaveLength(0);
  });

  it('isAdmin returns true for owner', async () => {
    await repo.create(userId, tenantId, 'owner');
    expect(await repo.isAdmin(userId, tenantId)).toBe(true);
  });

  it('isAdmin returns true for admin', async () => {
    await repo.create(userId, tenantId, 'admin');
    expect(await repo.isAdmin(userId, tenantId)).toBe(true);
  });

  it('isAdmin returns false for member', async () => {
    await repo.create(userId, tenantId, 'member');
    expect(await repo.isAdmin(userId, tenantId)).toBe(false);
  });

  it('returns empty array for unknown user', async () => {
    const tenants = await repo.findByUserId('unknown');
    expect(tenants).toHaveLength(0);
  });

  it('handles duplicate create gracefully (ON CONFLICT)', async () => {
    await repo.create(userId, tenantId, 'owner');
    // Second create with same user+tenant should not throw
    await repo.create(userId, tenantId, 'owner');
    const tenants = await repo.findByUserId(userId);
    expect(tenants).toHaveLength(1);
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
import { userTenants } from '../schema/user-tenants.js';
import type { Database } from '../connection.js';

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
  constructor(private db: Database) {}

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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../../src/types.js';

// We'll test the resolution logic by creating a mini Hono app
// that uses the auth middleware with a mock JWT provider

describe('JWT tenant resolution', () => {
  it('auto-selects tenant when user has exactly one', async () => {
    // Test: JWT user with 1 tenant → tenantId auto-set
    // This tests the middleware behavior, not the provider
    // Implementation will define the exact test structure
    expect(true).toBe(true); // Placeholder — replaced in Step 3
  });

  it('requires X-Tenant-Id header when user has multiple tenants', async () => {
    expect(true).toBe(true);
  });

  it('returns 400 when multi-tenant user omits X-Tenant-Id', async () => {
    expect(true).toBe(true);
  });

  it('returns 403 when user specifies tenant they do not belong to', async () => {
    expect(true).toBe(true);
  });

  it('auto-creates Free tenant for new JWT user with 0 tenants', async () => {
    expect(true).toBe(true);
  });

  it('does not modify tenantId for api-key strategy', async () => {
    expect(true).toBe(true);
  });

  it('does not modify tenantId for none strategy', async () => {
    expect(true).toBe(true);
  });
});
```

Note: The test placeholders will be replaced with full implementations in Step 3. The exact test structure depends on how the middleware is refactored. The implementer should write real tests using Hono's test client pattern (like the existing auth tests) that exercise:
- Mock `UserTenantRepository` returning 0, 1, or 2 tenant entries
- Mock `TenantRepository` for auto-creation
- Real Hono app with the updated middleware chain
- Assertions on response status and `c.get('tenantId')` value

- [ ] **Step 3: Implement JWT tenant resolution in auth middleware**

In `apps/api/src/middleware/auth.ts`, after the existing `c.set('tenantId', result.tenantId)` line (line 51), add the JWT branching logic:

```typescript
// After: const result = await provider.authenticate(c.req);

if (result.strategy === 'jwt') {
  // JWT path: resolve user → tenant(s) via user_tenants table
  const deps = c.get('deps') as AppDeps | undefined;
  const userTenantRepo = deps?.userTenantRepo;
  const tenantRepo = deps?.tenantRepo;

  if (!userTenantRepo || !tenantRepo) {
    return c.json({ error: { code: 'SERVER_ERROR', message: 'User-tenant resolution not configured' } }, 500);
  }

  let userTenants = await userTenantRepo.findByUserId(result.userId);

  if (userTenants.length === 0) {
    // Auto-create Free tenant for new user
    const tenant = await tenantRepo.create({
      name: result.userId, // Will be overridden by JWT name/email if available
    });
    await userTenantRepo.create(result.userId, tenant.id, 'owner');
    userTenants = [{ tenantId: tenant.id, role: 'owner', createdAt: new Date() }];
  }

  let resolvedTenantId: string;

  if (userTenants.length === 1) {
    resolvedTenantId = userTenants[0].tenantId;
  } else {
    // Multiple tenants — require X-Tenant-Id header
    const headerTenantId = c.req.header('x-tenant-id');
    if (!headerTenantId) {
      return c.json({
        error: {
          code: 'TENANT_REQUIRED',
          message: 'User belongs to multiple tenants. Set X-Tenant-Id header.',
          tenants: userTenants.map((ut) => ({ tenantId: ut.tenantId, role: ut.role })),
        },
      }, 400);
    }
    // Validate user actually belongs to this tenant
    const match = userTenants.find((ut) => ut.tenantId === headerTenantId);
    if (!match) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'User does not belong to the specified tenant' } }, 403);
    }
    resolvedTenantId = headerTenantId;
  }

  result.tenantId = resolvedTenantId;
}

// Existing: c.set('tenantId', result.tenantId);
// Existing: c.set('auth', result);
```

Important: The `deps` middleware runs AFTER auth middleware in the current chain (line 96 in app.ts). The auth middleware needs access to `userTenantRepo` and `tenantRepo` BEFORE the deps middleware sets them. Solution: pass the repos directly to the auth middleware function (like `authProvider` is currently passed), OR move deps injection before auth. The simplest approach is to pass the repos as additional arguments to `authMiddleware()`.

Update `authMiddleware` signature:

```typescript
export function authMiddleware(
  provider: AuthProvider,
  auditLogger?: AuditLogger,
  userTenantRepo?: UserTenantRepository,
  tenantRepo?: TenantRepository,
): MiddlewareHandler<AppEnv> {
```

- [ ] **Step 4: Wire userTenantRepo in app.ts**

In `apps/api/src/app.ts`, create the `UserTenantRepository` and pass it to auth middleware:

```typescript
import { UserTenantRepository } from '@spatula/db';

// In createApp():
const userTenantRepo = deps.db ? new UserTenantRepository(deps.db) : undefined;

// Update auth middleware call (around line 95):
app.use('/api/*', authMiddleware(authProvider, deps.auditLogger, userTenantRepo, deps.tenantRepo));

// Add to deps for route handlers:
if (userTenantRepo) {
  (deps as any).userTenantRepo = userTenantRepo;
}
```

- [ ] **Step 5: Write real tests and verify they pass**

Replace the placeholder tests from Step 2 with real Hono test client tests. Run:

```bash
pnpm --filter @spatula/api exec vitest run tests/unit/middleware/jwt-tenant-resolution.test.ts
```

Expected: 7 tests PASS

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
