# Wave 5-2: Billing & Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Stripe for usage-based billing with 4 tiers, enforce quotas across all billable dimensions, meter usage hourly, and align rate limiting with billing plans.

**Architecture:** Billing tiers define per-tenant limits across 6 dimensions (jobs, pages, tokens, storage, rate, export formats). Usage is recorded per-dimension in `usage_records` and reported to Stripe hourly by a metering worker. Quota enforcement happens at request time via a `QuotaEnforcer` service that checks current-period usage against tier limits. Stripe webhooks handle plan changes. Self-hosted deployments without `STRIPE_SECRET_KEY` degrade gracefully — billing endpoints return 503 and quota enforcement falls back to existing tenant-level quotas.

**Tech Stack:** Drizzle ORM (Postgres schema + migrations), Vitest, Hono routes, Stripe SDK, BullMQ repeatable jobs

**Spec reference:** `docs/superpowers/specs/2026-04-06-wave-5-decomposition-design.md` § 5-2

**Depends on:** Wave 5-1 (user_tenants table, JWT tenant resolution, Stripe SDK installed)

---

## File Map

| Action | Path                                                                  | Responsibility                                                       |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Create | `packages/shared/src/billing/tiers.ts`                                | Billing tier constants and types                                     |
| Create | `packages/db/src/schema/usage-records.ts`                             | Drizzle schema for usage_records table                               |
| Create | `packages/db/src/repositories/usage-record-repository.ts`             | Usage record CRUD + aggregation                                      |
| Create | `packages/db/tests/unit/repositories/usage-record-repository.test.ts` | Repository unit tests                                                |
| Create | `packages/core/src/billing/quota-enforcer.ts`                         | Quota enforcement service                                            |
| Create | `packages/core/src/billing/quota-enforcer.test.ts`                    | QuotaEnforcer unit tests                                             |
| Create | `apps/api/src/billing/stripe-client.ts`                               | Stripe API wrapper                                                   |
| Create | `apps/api/tests/unit/billing/stripe-client.test.ts`                   | Stripe client unit tests                                             |
| Create | `apps/api/src/routes/billing.ts`                                      | Billing API routes                                                   |
| Create | `apps/api/tests/unit/routes/billing.test.ts`                          | Billing route tests                                                  |
| Create | `apps/api/src/routes/stripe-webhook.ts`                               | Stripe webhook handler                                               |
| Create | `apps/api/tests/unit/routes/stripe-webhook.test.ts`                   | Webhook handler tests                                                |
| Create | `packages/queue/src/metering-worker.ts`                               | Hourly usage→Stripe metering worker                                  |
| Create | `packages/queue/tests/unit/metering-worker.test.ts`                   | Metering worker tests                                                |
| Modify | `packages/shared/src/billing/index.ts`                                | New barrel export for billing module                                 |
| Modify | `packages/shared/src/index.ts`                                        | Re-export billing module                                             |
| Modify | `packages/shared/src/auth/rate-limit-tiers.ts`                        | Rename tiers: standard→starter, enterprise→pro, unlimited→enterprise |
| Modify | `packages/db/src/schema/tenants.ts`                                   | Add `plan` and `stripeCustomerId` columns                            |
| Modify | `packages/db/src/schema/index.ts`                                     | Re-export usage-records schema                                       |
| Modify | `packages/db/src/index.ts`                                            | Export UsageRecordRepository                                         |
| Modify | `packages/db/src/repositories/tenant-repository.ts`                   | Add `updatePlan()` method                                            |
| Modify | `apps/api/src/types.ts`                                               | Add usageRecordRepo, stripeClient, quotaEnforcer to AppDeps          |
| Modify | `apps/api/src/app.ts`                                                 | Register billing routes, webhook route (skip auth), wire new deps    |
| Modify | `apps/api/src/middleware/auth.ts`                                     | Add webhook path to SKIP_AUTH_PATHS                                  |
| Modify | `apps/api/src/routes/exports.ts`                                      | Add format restriction check per tier                                |
| Modify | `packages/queue/src/queues.ts`                                        | Add METERING queue name                                              |
| Modify | `packages/queue/src/worker-entrypoint.ts`                             | Register metering worker                                             |
| Modify | `apps/api/src/routes/admin-queues.ts`                                 | Add metering queue to Bull Board                                     |
| Modify | `packages/shared/src/auth/types.ts`                                   | Add `billing:read` and `billing:write` to AUTH_SCOPES                |
| Modify | `packages/shared/tests/unit/auth/quotas.test.ts`                      | Update rate limit tier names in tests                                |
| Modify | `apps/api/tests/unit/middleware/rate-limit.test.ts`                   | Update rate limit tier names in tests                                |
| Create | `packages/core/src/billing/index.ts`                                  | Barrel export for billing module                                     |
| Modify | `packages/core/src/index.ts`                                          | Re-export billing module                                             |

---

### Task 1: Billing Tier Constants

**Files:**

- Create: `packages/shared/src/billing/tiers.ts`
- Create: `packages/shared/src/billing/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create billing tier types and constants**

`packages/shared/src/billing/tiers.ts`:

```typescript
export interface BillingTierLimits {
  jobsPerMonth: number;
  pagesPerMonth: number;
  llmTokensPerMonth: number;
  storageMb: number;
  exportFormats: string[];
  rateLimitPerMin: number;
}

export interface BillingTier {
  name: 'free' | 'starter' | 'pro' | 'enterprise';
  limits: BillingTierLimits;
}

export type BillingTierName = BillingTier['name'];

export const BILLING_TIERS: Record<BillingTierName, BillingTier> = {
  free: {
    name: 'free',
    limits: {
      jobsPerMonth: 5,
      pagesPerMonth: 1_000,
      llmTokensPerMonth: 100_000,
      storageMb: 100,
      exportFormats: ['json', 'csv'],
      rateLimitPerMin: 60,
    },
  },
  starter: {
    name: 'starter',
    limits: {
      jobsPerMonth: 50,
      pagesPerMonth: 10_000,
      llmTokensPerMonth: 1_000_000,
      storageMb: 1_000,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: 300,
    },
  },
  pro: {
    name: 'pro',
    limits: {
      jobsPerMonth: 500,
      pagesPerMonth: 100_000,
      llmTokensPerMonth: 10_000_000,
      storageMb: 10_000,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: 1_500,
    },
  },
  enterprise: {
    name: 'enterprise',
    limits: {
      jobsPerMonth: Infinity,
      pagesPerMonth: Infinity,
      llmTokensPerMonth: Infinity,
      storageMb: Infinity,
      exportFormats: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'],
      rateLimitPerMin: Infinity,
    },
  },
};

/** Billable dimension names matching usage_records.dimension column */
export type UsageDimension = 'jobs' | 'pages' | 'llm_tokens' | 'storage_bytes';

/** Map dimension to tier limit field */
export function getTierLimit(tier: BillingTierName, dimension: UsageDimension): number {
  const limits = BILLING_TIERS[tier]?.limits ?? BILLING_TIERS.free.limits;
  switch (dimension) {
    case 'jobs':
      return limits.jobsPerMonth;
    case 'pages':
      return limits.pagesPerMonth;
    case 'llm_tokens':
      return limits.llmTokensPerMonth;
    case 'storage_bytes':
      return limits.storageMb * 1_024 * 1_024;
    default:
      return Infinity;
  }
}
```

- [ ] **Step 2: Create billing barrel export**

`packages/shared/src/billing/index.ts`:

```typescript
export * from './tiers.js';
```

- [ ] **Step 3: Re-export billing from shared index**

In `packages/shared/src/index.ts`, add:

```typescript
export * from './billing/index.js';
```

- [ ] **Step 4: Add `billing:read` and `billing:write` to AUTH_SCOPES**

In `packages/shared/src/auth/types.ts`, add the new scopes to the `AUTH_SCOPES` array:

```typescript
export const AUTH_SCOPES = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
  'tenants:admin',
  'keys:manage',
  'billing:read',
  'billing:write',
  'admin',
] as const;
```

Also add `billing:read` to `DEFAULT_API_KEY_SCOPES` so API key holders can view their billing:

```typescript
export const DEFAULT_API_KEY_SCOPES: AuthScope[] = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
  'billing:read',
];
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/billing/ packages/shared/src/index.ts packages/shared/src/auth/types.ts
git commit -m "feat(shared): add billing tier constants, types, and billing auth scopes"
```

---

### Task 2: Rename Rate Limit Tiers to Match Billing Tiers

**Files:**

- Modify: `packages/shared/src/auth/rate-limit-tiers.ts`
- Grep + fix all references to old tier names

The existing tiers use names `free/standard/enterprise/unlimited` which don't match the billing tiers `free/starter/pro/enterprise`. Rename for consistency.

- [ ] **Step 1: Update rate-limit-tiers.ts**

Replace the entire `RATE_LIMIT_TIERS` object:

```typescript
export interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  free: { name: 'free', requestsPerMinute: 60, maxConcurrentJobs: 2 },
  starter: { name: 'starter', requestsPerMinute: 300, maxConcurrentJobs: 10 },
  pro: { name: 'pro', requestsPerMinute: 1500, maxConcurrentJobs: 50 },
  enterprise: { name: 'enterprise', requestsPerMinute: Infinity, maxConcurrentJobs: Infinity },
};
```

- [ ] **Step 2: Update test file `packages/shared/tests/unit/auth/quotas.test.ts`**

Specific changes needed:

- Line 42: Change expected keys from `['enterprise', 'free', 'standard', 'unlimited']` to `['enterprise', 'free', 'pro', 'starter']`
- Lines 54-56: Rename `standard` → `starter`, `enterprise` → `pro` in the destructuring and comparisons
- Lines 59-62: Rename `RATE_LIMIT_TIERS.unlimited` to `RATE_LIMIT_TIERS.enterprise`

- [ ] **Step 3: Update test file `apps/api/tests/unit/middleware/rate-limit.test.ts`**

Specific changes needed:

- Line 47: Change `'unlimited'` to `'enterprise'` in the skip test
- Lines 54-59: Change `'standard'` to `'starter'` in the tier limit test

- [ ] **Step 4: Run tests to verify no breakage**

```bash
pnpm --filter @spatula/shared test && pnpm --filter @spatula/api test
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/auth/rate-limit-tiers.ts packages/shared/tests/unit/auth/quotas.test.ts apps/api/tests/unit/middleware/rate-limit.test.ts
git commit -m "refactor(shared): rename rate limit tiers to match billing tiers (standard→starter, enterprise→pro, unlimited→enterprise)"
```

---

### Task 3: Tenant Schema Extension (plan + stripe_customer_id)

**Files:**

- Modify: `packages/db/src/schema/tenants.ts`
- Modify: `packages/db/src/repositories/tenant-repository.ts`

- [ ] **Step 1: Add plan and stripeCustomerId columns to tenants schema**

In `packages/db/src/schema/tenants.ts`, add two new columns after `storageBytesUsed`:

```typescript
import { pgTable, uuid, text, jsonb, timestamp, bigint, varchar } from 'drizzle-orm/pg-core';

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
  plan: varchar('plan', { length: 20 }).notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add updatePlan() method to TenantRepository**

In `packages/db/src/repositories/tenant-repository.ts`, add after the `update()` method:

```typescript
async updatePlan(tenantId: string, plan: string, stripeCustomerId?: string): Promise<void> {
  try {
    const updates: Record<string, unknown> = { plan };
    if (stripeCustomerId !== undefined) {
      updates.stripeCustomerId = stripeCustomerId;
    }
    await this.db
      .update(tenants)
      .set(updates)
      .where(eq(tenants.id, tenantId));

    // Invalidate cached quotas (plan change affects rate limit tier)
    if (this.cache) {
      await this.cache.delete(`tenant:${tenantId}:quotas`);
    }

    logger.info({ tenantId, plan }, 'tenant plan updated');
  } catch (error) {
    throw new StorageError(`Failed to update tenant plan: ${(error as Error).message}`, {
      cause: error as Error,
      context: { tenantId, plan },
    });
  }
}
```

Also add `getPlan()` method for quick plan lookups:

```typescript
async getPlan(tenantId: string): Promise<string> {
  try {
    const [row] = await this.db
      .select({ plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!row) throw new StorageError(`Tenant ${tenantId} not found`, { context: { id: tenantId } });
    return row.plan;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(`Failed to get plan: ${(error as Error).message}`, {
      cause: error as Error,
      context: { tenantId },
    });
  }
}
```

- [ ] **Step 3: Generate migration**

```bash
cd packages/db && npx drizzle-kit generate
```

Verify the migration adds `ALTER TABLE tenants ADD COLUMN plan VARCHAR(20) NOT NULL DEFAULT 'free'` and `ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT`.

- [ ] **Step 4: Run existing tenant tests to check for breakage**

```bash
pnpm --filter @spatula/db test
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/tenants.ts packages/db/src/repositories/tenant-repository.ts packages/db/drizzle/
git commit -m "feat(db): add plan and stripe_customer_id columns to tenants table"
```

---

### Task 4: usage_records Schema + Repository

**Files:**

- Create: `packages/db/src/schema/usage-records.ts`
- Create: `packages/db/src/repositories/usage-record-repository.ts`
- Create: `packages/db/tests/unit/repositories/usage-record-repository.test.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Create usage_records schema**

`packages/db/src/schema/usage-records.ts`:

```typescript
import {
  pgTable,
  uuid,
  varchar,
  bigint,
  date,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dimension: varchar('dimension', { length: 50 }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    reportedToStripe: boolean('reported_to_stripe').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_usage_tenant_period').on(table.tenantId, table.periodStart, table.dimension),
  ],
);
```

- [ ] **Step 2: Add re-export to schema index**

In `packages/db/src/schema/index.ts`, add:

```typescript
export * from './usage-records.js';
```

- [ ] **Step 3: Write failing tests**

`packages/db/tests/unit/repositories/usage-record-repository.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { UsageRecordRepository } from '../../../src/repositories/usage-record-repository.js';

function createMockDb() {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    _mocks: { mockValues, mockOnConflictDoUpdate, mockWhere, mockFrom, mockSet },
  };
  return db;
}

describe('UsageRecordRepository', () => {
  it('record() inserts a usage record', async () => {
    const db = createMockDb();
    const repo = new UsageRecordRepository(db as any);
    await repo.record('tenant-1', 'pages', 50);
    expect(db.insert).toHaveBeenCalled();
  });

  it('getCurrentUsage() returns sum for current period', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([{ total: 150 }]);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getCurrentUsage('tenant-1', 'pages');
    expect(typeof result).toBe('number');
  });

  it('getCurrentUsage() returns 0 for empty result', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([{ total: null }]);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getCurrentUsage('tenant-1', 'pages');
    expect(result).toBe(0);
  });

  it('getUnreported() returns unreported records', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 50, reportedToStripe: false },
    ]);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getUnreported(100);
    expect(result).toHaveLength(1);
  });

  it('markReported() updates records', async () => {
    const db = createMockDb();
    const repo = new UsageRecordRepository(db as any);
    await repo.markReported(['r1', 'r2']);
    expect(db.update).toHaveBeenCalled();
  });

  it('aggregateByTenant() returns aggregated usage', async () => {
    const db = createMockDb();
    db._mocks.mockWhere.mockResolvedValue([
      { dimension: 'pages', total: 500 },
      { dimension: 'llm_tokens', total: 10000 },
    ]);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.aggregateByTenant(
      'tenant-1',
      new Date('2026-03-01'),
      new Date('2026-03-31'),
    );
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
pnpm --filter @spatula/db exec vitest run tests/unit/repositories/usage-record-repository.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 5: Implement UsageRecordRepository**

`packages/db/src/repositories/usage-record-repository.ts`:

```typescript
import { eq, and, sql, gte, lte, inArray } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { usageRecords } from '../schema/usage-records.js';
import type { Database } from '../connection.js';

const logger = createLogger('usage-record-repository');

export interface UsageRecord {
  id: string;
  tenantId: string;
  dimension: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
  reportedToStripe: boolean;
  createdAt: Date;
}

export interface DimensionUsage {
  dimension: string;
  total: number;
}

/**
 * Get the current billing period boundaries (1st of month to 1st of next month).
 */
function getCurrentPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export class UsageRecordRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record usage for a tenant+dimension in the current billing period.
   * Inserts a new row per recording event (not upsert — multiple rows per period
   * allows granular Stripe reporting and audit trail).
   */
  async record(tenantId: string, dimension: string, quantity: number): Promise<void> {
    const { start, end } = getCurrentPeriod();
    try {
      await this.db.insert(usageRecords).values({
        tenantId,
        dimension,
        quantity,
        periodStart: start,
        periodEnd: end,
      });
    } catch (error) {
      throw new StorageError(`Failed to record usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, dimension, quantity },
      });
    }
  }

  /**
   * Get total usage for a tenant+dimension in the current billing period.
   */
  async getCurrentUsage(tenantId: string, dimension: string): Promise<number> {
    const { start, end } = getCurrentPeriod();
    try {
      const [row] = await this.db
        .select({ total: sql<number>`COALESCE(SUM(${usageRecords.quantity}), 0)` })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            eq(usageRecords.dimension, dimension),
            eq(usageRecords.periodStart, start),
          ),
        );
      return Number(row?.total ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to get current usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, dimension },
      });
    }
  }

  /**
   * Fetch unreported records for Stripe metering (oldest first).
   */
  async getUnreported(limit: number): Promise<UsageRecord[]> {
    try {
      const rows = await this.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.reportedToStripe, false))
        .orderBy(usageRecords.createdAt)
        .limit(limit);
      return rows as unknown as UsageRecord[];
    } catch (error) {
      throw new StorageError(`Failed to get unreported usage: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Mark records as reported to Stripe.
   */
  async markReported(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.db
        .update(usageRecords)
        .set({ reportedToStripe: true })
        .where(inArray(usageRecords.id, ids));
    } catch (error) {
      throw new StorageError(`Failed to mark usage as reported: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ids },
      });
    }
  }

  /**
   * Aggregate usage by dimension for a tenant within a date range.
   */
  async aggregateByTenant(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<DimensionUsage[]> {
    try {
      const rows = await this.db
        .select({
          dimension: usageRecords.dimension,
          total: sql<number>`COALESCE(SUM(${usageRecords.quantity}), 0)`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            gte(usageRecords.periodStart, startDate.toISOString().slice(0, 10)),
            lte(usageRecords.periodEnd, endDate.toISOString().slice(0, 10)),
          ),
        )
        .groupBy(usageRecords.dimension);
      return rows.map((r) => ({ dimension: r.dimension, total: Number(r.total) }));
    } catch (error) {
      throw new StorageError(`Failed to aggregate usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
```

- [ ] **Step 6: Export from packages/db/src/index.ts**

Add to `packages/db/src/index.ts`:

```typescript
export { UsageRecordRepository } from './repositories/usage-record-repository.js';
export type { UsageRecord, DimensionUsage } from './repositories/usage-record-repository.js';
```

- [ ] **Step 7: Generate migration**

```bash
cd packages/db && npx drizzle-kit generate
```

Verify migration creates `usage_records` table with the index.

- [ ] **Step 8: Run tests to verify they pass**

```bash
pnpm --filter @spatula/db exec vitest run tests/unit/repositories/usage-record-repository.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/usage-records.ts packages/db/src/schema/index.ts packages/db/src/repositories/usage-record-repository.ts packages/db/tests/unit/repositories/usage-record-repository.test.ts packages/db/src/index.ts packages/db/drizzle/
git commit -m "feat(db): add usage_records schema and UsageRecordRepository"
```

---

### Task 5: Quota Enforcement Service

**Files:**

- Create: `packages/core/src/billing/quota-enforcer.ts`
- Create: `packages/core/src/billing/quota-enforcer.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/core/src/billing/quota-enforcer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { QuotaEnforcer } from './quota-enforcer.js';

function createMockUsageRepo(usage: Record<string, number> = {}) {
  return {
    getCurrentUsage: vi
      .fn()
      .mockImplementation((_tenantId: string, dimension: string) =>
        Promise.resolve(usage[dimension] ?? 0),
      ),
    record: vi.fn(),
    getUnreported: vi.fn(),
    markReported: vi.fn(),
    aggregateByTenant: vi.fn(),
  };
}

function createMockTenantRepo(plan = 'free') {
  return {
    getPlan: vi.fn().mockResolvedValue(plan),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    getQuotas: vi.fn(),
    incrementStorageBytes: vi.fn(),
    updatePlan: vi.fn(),
    setCache: vi.fn(),
  };
}

describe('QuotaEnforcer', () => {
  it('allows request when under limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 100 }) as any,
      createMockTenantRepo('free') as any,
    );
    await expect(enforcer.check('tenant-1', 'pages', 10)).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when over limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 990 }) as any,
      createMockTenantRepo('free') as any,
    );
    // Free tier: 1000 pages/month. 990 + 50 = 1040 > 1000
    await expect(enforcer.check('tenant-1', 'pages', 50)).rejects.toThrow('Quota exceeded');
  });

  it('allows enterprise tier without limit', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo({ pages: 999_999 }) as any,
      createMockTenantRepo('enterprise') as any,
    );
    await expect(enforcer.check('tenant-1', 'pages', 100)).resolves.toBeUndefined();
  });

  it('checks export format against tier', async () => {
    const enforcer = new QuotaEnforcer(
      createMockUsageRepo() as any,
      createMockTenantRepo('free') as any,
    );
    // Free tier only allows json, csv
    expect(enforcer.isExportFormatAllowed('free', 'json')).toBe(true);
    expect(enforcer.isExportFormatAllowed('free', 'csv')).toBe(true);
    expect(enforcer.isExportFormatAllowed('free', 'parquet')).toBe(false);
    expect(enforcer.isExportFormatAllowed('free', 'duckdb')).toBe(false);
    expect(enforcer.isExportFormatAllowed('starter', 'parquet')).toBe(true);
  });

  it('records usage after successful check', async () => {
    const usageRepo = createMockUsageRepo({ jobs: 0 });
    const enforcer = new QuotaEnforcer(usageRepo as any, createMockTenantRepo('free') as any);
    await enforcer.checkAndRecord('tenant-1', 'jobs', 1);
    expect(usageRepo.record).toHaveBeenCalledWith('tenant-1', 'jobs', 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @spatula/core exec vitest run src/billing/quota-enforcer.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement QuotaEnforcer**

`packages/core/src/billing/quota-enforcer.ts`:

```typescript
import { QuotaExceededError, BILLING_TIERS, getTierLimit } from '@spatula/shared';
import type { BillingTierName, UsageDimension } from '@spatula/shared';
import type { UsageRecordRepository } from '@spatula/db';
import type { TenantRepository } from '@spatula/db';

export class QuotaEnforcer {
  constructor(
    private readonly usageRepo: UsageRecordRepository,
    private readonly tenantRepo: TenantRepository,
  ) {}

  /**
   * Check if a tenant can use `requested` units of the given dimension.
   * Throws QuotaExceededError if the request would exceed the tier limit.
   */
  async check(tenantId: string, dimension: UsageDimension, requested: number): Promise<void> {
    const plan = (await this.tenantRepo.getPlan(tenantId)) as BillingTierName;
    const limit = getTierLimit(plan, dimension);

    if (limit === Infinity) return; // Enterprise — no limit

    const current = await this.usageRepo.getCurrentUsage(tenantId, dimension);
    if (current + requested > limit) {
      throw new QuotaExceededError(
        `Quota exceeded for ${dimension}: ${current + requested} > ${limit} (plan: ${plan})`,
        { context: { tenantId, dimension, current, requested, limit, plan } },
      );
    }
  }

  /**
   * Check quota then record usage. NOT atomic — two concurrent calls may both
   * pass the check before either records. This is acceptable because:
   * 1. Billing dimensions are soft limits (slight overage is fine)
   * 2. True atomicity would require DB-level locking (disproportionate cost)
   * 3. The metering worker reports actual usage to Stripe regardless
   * Use this when the usage should be tracked immediately (e.g., job creation).
   */
  async checkAndRecord(
    tenantId: string,
    dimension: UsageDimension,
    quantity: number,
  ): Promise<void> {
    await this.check(tenantId, dimension, quantity);
    await this.usageRepo.record(tenantId, dimension, quantity);
  }

  /**
   * Check if an export format is allowed for the given tier.
   */
  isExportFormatAllowed(plan: string, format: string): boolean {
    const tier = BILLING_TIERS[plan as BillingTierName] ?? BILLING_TIERS.free;
    return tier.limits.exportFormats.includes(format);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/core exec vitest run src/billing/quota-enforcer.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 5: Create barrel export and wire into core index**

Create `packages/core/src/billing/index.ts`:

```typescript
export { QuotaEnforcer } from './quota-enforcer.js';
```

Add to `packages/core/src/index.ts`:

```typescript
// Billing
export * from './billing/index.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/billing/ packages/core/src/index.ts
git commit -m "feat(core): add QuotaEnforcer service for billing dimension checks"
```

---

### Task 6: Stripe Client Wrapper

**Files:**

- Create: `apps/api/src/billing/stripe-client.ts`
- Create: `apps/api/tests/unit/billing/stripe-client.test.ts`

- [ ] **Step 1: Write failing tests**

`apps/api/tests/unit/billing/stripe-client.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SpatulaStripeClient } from '../../../src/billing/stripe-client.js';

function createMockStripe() {
  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test123' }),
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/session/test' }),
      },
    },
    subscriptions: {
      list: vi.fn().mockResolvedValue({
        data: [{ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1' }] } }],
      }),
    },
    invoices: {
      list: vi
        .fn()
        .mockResolvedValue({ data: [{ id: 'inv_1', amount_due: 1000, status: 'paid' }] }),
    },
    subscriptionItems: {
      createUsageRecord: vi.fn().mockResolvedValue({ id: 'mbur_1' }),
    },
    webhooks: {
      constructEvent: vi
        .fn()
        .mockReturnValue({ type: 'customer.subscription.updated', data: { object: {} } }),
    },
  };
}

describe('SpatulaStripeClient', () => {
  it('createCustomer returns Stripe customer ID', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const customerId = await client.createCustomer('tenant-1', 'user@example.com');
    expect(customerId).toBe('cus_test123');
    expect(stripe.customers.create).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { tenantId: 'tenant-1' },
    });
  });

  it('createPortalSession returns portal URL', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const url = await client.createPortalSession('cus_test123', 'https://app.spatula.dev/billing');
    expect(url).toBe('https://billing.stripe.com/session/test');
  });

  it('getSubscription returns active subscription', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const sub = await client.getSubscription('cus_test123');
    expect(sub).toBeDefined();
    expect(sub!.id).toBe('sub_1');
  });

  it('getInvoices returns invoice list', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const invoices = await client.getInvoices('cus_test123', 10);
    expect(invoices).toHaveLength(1);
  });

  it('reportUsage calls subscriptionItems.createUsageRecord', async () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    await client.reportUsage('si_1', 500);
    expect(stripe.subscriptionItems.createUsageRecord).toHaveBeenCalledWith('si_1', {
      quantity: 500,
      action: 'set',
    });
  });

  it('verifyWebhook calls constructEvent', () => {
    const stripe = createMockStripe();
    const client = new SpatulaStripeClient(stripe as any);
    const event = client.verifyWebhook('raw-body', 'sig', 'whsec_test');
    expect(event.type).toBe('customer.subscription.updated');
  });

  it('isConfigured() returns false when no Stripe instance', () => {
    const client = new SpatulaStripeClient(null as any);
    expect(client.isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Implement SpatulaStripeClient**

`apps/api/src/billing/stripe-client.ts`:

```typescript
import Stripe from 'stripe';
import { createLogger } from '@spatula/shared';

const logger = createLogger('stripe-client');

export class SpatulaStripeClient {
  constructor(private readonly stripe: Stripe | null) {}

  isConfigured(): boolean {
    return this.stripe !== null;
  }

  async createCustomer(tenantId: string, email: string): Promise<string> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const customer = await this.stripe.customers.create({
      email,
      metadata: { tenantId },
    });
    logger.info({ tenantId, customerId: customer.id }, 'Stripe customer created');
    return customer.id;
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  async getSubscription(customerId: string): Promise<Stripe.Subscription | null> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const list = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    return list.data[0] ?? null;
  }

  async getInvoices(customerId: string, limit: number): Promise<Stripe.Invoice[]> {
    if (!this.stripe) throw new Error('Stripe not configured');
    const list = await this.stripe.invoices.list({
      customer: customerId,
      limit,
    });
    return list.data;
  }

  async reportUsage(subscriptionItemId: string, quantity: number): Promise<void> {
    if (!this.stripe) throw new Error('Stripe not configured');
    await this.stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
      quantity,
      action: 'set',
    });
  }

  verifyWebhook(rawBody: string, signature: string, webhookSecret: string): Stripe.Event {
    if (!this.stripe) throw new Error('Stripe not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}

/**
 * Create a SpatulaStripeClient. Returns a client with null Stripe instance
 * when STRIPE_SECRET_KEY is not set (self-hosted mode).
 */
export function createStripeClient(): SpatulaStripeClient {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    logger.info('Stripe not configured — billing features disabled');
    return new SpatulaStripeClient(null);
  }
  const stripe = new Stripe(secretKey);
  return new SpatulaStripeClient(stripe);
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/api exec vitest run tests/unit/billing/stripe-client.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/billing/ apps/api/tests/unit/billing/
git commit -m "feat(api): add SpatulaStripeClient wrapper for Stripe API"
```

---

### Task 7: Billing API Routes

**Files:**

- Create: `apps/api/src/routes/billing.ts`
- Create: `apps/api/tests/unit/routes/billing.test.ts`
- Modify: `apps/api/src/types.ts` (add new deps)
- Modify: `apps/api/src/app.ts` (register routes)

- [ ] **Step 1: Add new deps to AppDeps**

In `apps/api/src/types.ts`, add imports and fields:

```typescript
import type { UsageRecordRepository } from '@spatula/db';
import type { SpatulaStripeClient } from './billing/stripe-client.js';
import type { QuotaEnforcer } from '@spatula/core';
```

Add to `AppDeps`:

```typescript
  usageRecordRepo?: UsageRecordRepository;
  stripeClient?: SpatulaStripeClient;
  quotaEnforcer?: QuotaEnforcer;
```

Note: Import `QuotaEnforcer` via type import from `@spatula/core`. If `@spatula/core` doesn't yet export it, add the export in `packages/core/src/index.ts`.

- [ ] **Step 2: Write billing route tests**

`apps/api/tests/unit/routes/billing.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { billingRoutes } from '../../../src/routes/billing.js';

function createTestApp(stripeConfigured = true, plan = 'free', stripeCustomerId = 'cus_1') {
  const app = new Hono();

  const mockStripeClient = {
    isConfigured: () => stripeConfigured,
    getSubscription: vi.fn().mockResolvedValue({ id: 'sub_1', status: 'active' }),
    getInvoices: vi.fn().mockResolvedValue([{ id: 'inv_1', amount_due: 1000 }]),
    createPortalSession: vi.fn().mockResolvedValue('https://billing.stripe.com/portal'),
  };

  const mockTenantRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'tenant-1', plan, stripeCustomerId }),
  };

  const mockUsageRecordRepo = {
    aggregateByTenant: vi.fn().mockResolvedValue([
      { dimension: 'pages', total: 500 },
      { dimension: 'llm_tokens', total: 5000 },
    ]),
  };

  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', {
      tenantId: 'tenant-1',
      userId: 'user-1',
      scopes: ['billing:read', 'billing:write'],
      strategy: 'jwt',
    });
    c.set('deps', {
      stripeClient: mockStripeClient,
      tenantRepo: mockTenantRepo,
      usageRecordRepo: mockUsageRecordRepo,
    });
    return next();
  });

  app.route('/api/v1/billing', billingRoutes());

  return { app, mockStripeClient, mockTenantRepo };
}

describe('billing routes', () => {
  it('GET /subscription returns plan and usage', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/v1/billing/subscription');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plan).toBe('free');
  });

  it('GET /subscription returns 503 when Stripe not configured', async () => {
    const { app } = createTestApp(false);
    const res = await app.request('/api/v1/billing/subscription');
    expect(res.status).toBe(503);
  });

  it('GET /invoices returns invoice list', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/v1/billing/invoices');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('POST /portal returns redirect URL', async () => {
    const { app, mockStripeClient } = createTestApp();
    const res = await app.request('/api/v1/billing/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnUrl: 'https://app.spatula.dev' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toBe('https://billing.stripe.com/portal');
  });
});
```

- [ ] **Step 3: Implement billing routes**

`apps/api/src/routes/billing.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { BILLING_TIERS } from '@spatula/shared';
import type { BillingTierName } from '@spatula/shared';

export function billingRoutes() {
  const app = new Hono<AppEnv>();

  // GET /subscription — current plan, usage vs limits, Stripe subscription
  app.get('/subscription', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    const plan = (tenant.plan ?? 'free') as BillingTierName;
    const tier = BILLING_TIERS[plan] ?? BILLING_TIERS.free;

    // Fetch current period usage
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const usage = deps.usageRecordRepo
      ? await deps.usageRecordRepo.aggregateByTenant(tenantId, periodStart, periodEnd)
      : [];

    const usageMap: Record<string, number> = {};
    for (const u of usage) {
      usageMap[u.dimension] = u.total;
    }

    // Fetch Stripe subscription if customer exists
    let subscription = null;
    if (tenant.stripeCustomerId) {
      subscription = await deps.stripeClient.getSubscription(tenant.stripeCustomerId);
    }

    // Convert Infinity to -1 for JSON serialization (JSON doesn't support Infinity)
    const serializableLimits = Object.fromEntries(
      Object.entries(tier.limits).map(([k, v]) => [k, v === Infinity ? -1 : v]),
    );

    return c.json({
      data: {
        plan,
        limits: serializableLimits,
        usage: usageMap,
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        stripeSubscription: subscription
          ? { id: subscription.id, status: subscription.status }
          : null,
      },
    });
  });

  // GET /invoices — past invoices from Stripe
  app.get('/invoices', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!tenant?.stripeCustomerId) {
      return c.json({ data: [] });
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 100);
    const invoices = await deps.stripeClient.getInvoices(tenant.stripeCustomerId, limit);

    return c.json({
      data: invoices.map((inv) => ({
        id: inv.id,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        status: inv.status,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        hostedInvoiceUrl: inv.hosted_invoice_url,
      })),
    });
  });

  // POST /portal — create Stripe Customer Portal session
  app.post('/portal', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Billing not configured' } }, 503);
    }
    const tenantId = c.get('tenantId');
    const tenant = await deps.tenantRepo!.findById(tenantId);
    if (!tenant?.stripeCustomerId) {
      return c.json(
        {
          error: { code: 'NO_CUSTOMER', message: 'No Stripe customer. Subscribe to a plan first.' },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const returnUrl = body.returnUrl ?? 'https://app.spatula.dev/billing';
    const url = await deps.stripeClient.createPortalSession(tenant.stripeCustomerId, returnUrl);

    return c.json({ data: { url } });
  });

  return app;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/api exec vitest run tests/unit/routes/billing.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing.ts apps/api/tests/unit/routes/billing.test.ts apps/api/src/types.ts
git commit -m "feat(api): add billing routes (subscription, invoices, portal)"
```

---

### Task 8: Stripe Webhook Handler

**Files:**

- Create: `apps/api/src/routes/stripe-webhook.ts`
- Create: `apps/api/tests/unit/routes/stripe-webhook.test.ts`
- Modify: `apps/api/src/middleware/auth.ts` (skip auth for webhook path)
- Modify: `apps/api/src/app.ts` (register webhook route before auth)

The Stripe webhook endpoint must bypass auth middleware entirely. Stripe sends events directly with its own signature verification.

- [ ] **Step 1: Write webhook handler tests**

`apps/api/tests/unit/routes/stripe-webhook.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { stripeWebhookRoutes } from '../../../src/routes/stripe-webhook.js';

function createMockDeps(overrides: Record<string, any> = {}) {
  return {
    stripeClient: {
      isConfigured: () => true,
      verifyWebhook: vi.fn().mockReturnValue({
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_1',
            status: 'active',
            metadata: { plan: 'pro' },
          },
        },
      }),
      ...overrides.stripeClient,
    },
    tenantRepo: {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'tenant-1', plan: 'free', stripeCustomerId: 'cus_1' }),
      updatePlan: vi.fn().mockResolvedValue(undefined),
      ...overrides.tenantRepo,
    },
    auditLogger: {
      log: vi.fn(),
      ...overrides.auditLogger,
    },
  };
}

function createTestApp(deps: any) {
  const app = new Hono();
  // No auth middleware — webhook routes are unauthenticated
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    return next();
  });
  app.route('/api/v1/webhooks/stripe', stripeWebhookRoutes());
  return app;
}

describe('Stripe webhook handler', () => {
  it('handles customer.subscription.updated event', async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{"test":"body"}',
    });
    expect(res.status).toBe(200);
    expect(deps.stripeClient.verifyWebhook).toHaveBeenCalled();
  });

  it('handles customer.subscription.deleted event (downgrade to free)', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockReturnValue({
          type: 'customer.subscription.deleted',
          data: { object: { customer: 'cus_1' } },
        }),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(deps.tenantRepo.updatePlan).toHaveBeenCalledWith('tenant-1', 'free');
  });

  it('handles unknown Stripe customer gracefully', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockReturnValue({
          type: 'customer.subscription.updated',
          data: {
            object: { customer: 'cus_unknown', status: 'active', metadata: { plan: 'pro' } },
          },
        }),
      },
      tenantRepo: {
        findById: vi.fn().mockResolvedValue(null),
        findByStripeCustomerId: vi.fn().mockResolvedValue(null),
        updatePlan: vi.fn(),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    // Should return 200 (ack to Stripe) even if tenant not found
    expect(res.status).toBe(200);
    expect(deps.tenantRepo.updatePlan).not.toHaveBeenCalled();
  });

  it('returns 400 when signature verification fails', async () => {
    const deps = createMockDeps({
      stripeClient: {
        isConfigured: () => true,
        verifyWebhook: vi.fn().mockImplementation(() => {
          throw new Error('Invalid signature');
        }),
      },
    });
    const app = createTestApp(deps);
    const res = await app.request('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad-sig', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implement webhook handler**

`apps/api/src/routes/stripe-webhook.ts`:

```typescript
import { Hono } from 'hono';
import { createLogger } from '@spatula/shared';

const logger = createLogger('stripe-webhook');

/**
 * Stripe webhook handler. This route is NOT behind auth middleware.
 * Authentication is handled by Stripe webhook signature verification.
 *
 * Handled events:
 * - customer.subscription.updated → update tenant plan
 * - customer.subscription.deleted → downgrade to free
 * - invoice.payment_failed → log for alerting (tenant flagging is future work)
 */
export function stripeWebhookRoutes() {
  const app = new Hono();

  app.post('/', async (c) => {
    const deps = c.get('deps') as any;
    const stripeClient = deps.stripeClient;

    if (!stripeClient?.isConfigured()) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Stripe not configured' } }, 503);
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Webhook secret not configured' } },
        503,
      );
    }

    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'Missing stripe-signature header' } },
        400,
      );
    }

    const rawBody = await c.req.text();

    let event;
    try {
      event = stripeClient.verifyWebhook(rawBody, signature, webhookSecret);
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Webhook signature verification failed');
      return c.json(
        { error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } },
        400,
      );
    }

    logger.info({ eventType: event.type, eventId: event.id }, 'Stripe webhook received');

    try {
      switch (event.type) {
        case 'customer.subscription.updated': {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;
          const plan = subscription.metadata?.plan ?? 'free';
          await handleSubscriptionUpdate(deps, customerId, plan);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object as any;
          const customerId = subscription.customer as string;
          await handleSubscriptionDeleted(deps, customerId);
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;
          const customerId = invoice.customer as string;
          logger.warn({ customerId }, 'Invoice payment failed');
          // Future: flag tenant, send notification
          break;
        }
        default:
          logger.debug({ eventType: event.type }, 'Unhandled Stripe event type');
      }
    } catch (err) {
      logger.error(
        { eventType: event.type, error: (err as Error).message },
        'Error handling webhook event',
      );
      // Return 200 anyway — Stripe will retry on 5xx, but we don't want retries for business logic errors
    }

    return c.json({ received: true });
  });

  return app;
}

async function handleSubscriptionUpdate(
  deps: any,
  customerId: string,
  plan: string,
): Promise<void> {
  const tenant = await findTenantByStripeCustomer(deps, customerId);
  if (!tenant) {
    logger.warn({ customerId }, 'No tenant found for Stripe customer');
    return;
  }

  await deps.tenantRepo.updatePlan(tenant.id, plan);

  if (deps.auditLogger) {
    deps.auditLogger.log({
      tenantId: tenant.id,
      actorId: 'stripe',
      actorType: 'system',
      action: 'billing.plan_changed',
      metadata: { oldPlan: tenant.plan, newPlan: plan, customerId },
    });
  }

  logger.info({ tenantId: tenant.id, plan }, 'Tenant plan updated via Stripe webhook');
}

async function handleSubscriptionDeleted(deps: any, customerId: string): Promise<void> {
  const tenant = await findTenantByStripeCustomer(deps, customerId);
  if (!tenant) return;

  await deps.tenantRepo.updatePlan(tenant.id, 'free');

  if (deps.auditLogger) {
    deps.auditLogger.log({
      tenantId: tenant.id,
      actorId: 'stripe',
      actorType: 'system',
      action: 'billing.subscription_cancelled',
      metadata: { oldPlan: tenant.plan, customerId },
    });
  }

  logger.info({ tenantId: tenant.id }, 'Tenant downgraded to free (subscription deleted)');
}

async function findTenantByStripeCustomer(deps: any, customerId: string) {
  return deps.tenantRepo.findByStripeCustomerId(customerId);
}
```

- [ ] **Step 3: Add findByStripeCustomerId to TenantRepository**

In `packages/db/src/repositories/tenant-repository.ts`, add:

```typescript
async findByStripeCustomerId(stripeCustomerId: string) {
  try {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.stripeCustomerId, stripeCustomerId));
    return row ?? null;
  } catch (error) {
    throw new StorageError(`Failed to find tenant by Stripe customer: ${(error as Error).message}`, {
      cause: error as Error,
      context: { stripeCustomerId },
    });
  }
}
```

- [ ] **Step 4: Add webhook path to SKIP_AUTH_PREFIXES in auth middleware**

In `apps/api/src/middleware/auth.ts`, add to `SKIP_AUTH_PREFIXES`:

```typescript
const SKIP_AUTH_PREFIXES = ['/api/v1/tenants', '/api/v1/webhooks/stripe'];
```

- [ ] **Step 5: Register webhook route in app.ts (BEFORE auth middleware)**

In `apps/api/src/app.ts`, the webhook route needs the deps middleware but NOT auth. Register it after health checks but add it to the auth skip list (done in Step 4). The route will be registered in the normal route section since the SKIP_AUTH_PREFIXES handles bypassing auth:

```typescript
// Stripe webhook (no auth — uses Stripe signature verification)
app.route('/api/v1/webhooks/stripe', stripeWebhookRoutes());
```

Add the import at the top of `app.ts`:

```typescript
import { stripeWebhookRoutes } from './routes/stripe-webhook.js';
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @spatula/api exec vitest run tests/unit/routes/stripe-webhook.test.ts
```

Expected: 3 tests PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/stripe-webhook.ts apps/api/tests/unit/routes/stripe-webhook.test.ts apps/api/src/middleware/auth.ts apps/api/src/app.ts packages/db/src/repositories/tenant-repository.ts
git commit -m "feat(api): add Stripe webhook handler with signature verification"
```

---

### Task 9: Export Format Restriction per Tier

**Files:**

- Modify: `apps/api/src/routes/exports.ts`

- [ ] **Step 1: Add format check before export creation**

In `apps/api/src/routes/exports.ts`, in the `triggerExportRoute` handler (around line 121-152), add a format check after extracting the body but before creating the export record:

```typescript
// Check export format against tenant's billing plan
if (deps.quotaEnforcer) {
  const tenant = await deps.tenantRepo!.findById(tenantId);
  const plan = tenant?.plan ?? 'free';
  if (!deps.quotaEnforcer.isExportFormatAllowed(plan, body.format)) {
    return c.json(
      {
        error: {
          code: 'EXPORT_FORMAT_RESTRICTED',
          message: `Export format '${body.format}' is not available on the ${plan} plan. Upgrade to access this format.`,
        },
      },
      403,
    );
  }
}
```

This needs to be added after `const deps = c.get('deps');` and before `const exportRecord = await deps.exportRepo.create(...)`.

- [ ] **Step 2: Run existing export tests**

```bash
pnpm --filter @spatula/api exec vitest run tests/ --grep "export"
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/exports.ts
git commit -m "feat(api): restrict export formats based on billing tier"
```

---

### Task 10: Metering Queue + Worker

**Files:**

- Modify: `packages/queue/src/queues.ts` (add METERING queue name)
- Create: `packages/queue/src/metering-worker.ts`
- Create: `packages/queue/tests/unit/metering-worker.test.ts`
- Modify: `packages/queue/src/worker-entrypoint.ts` (register metering worker)
- Modify: `apps/api/src/routes/admin-queues.ts` (add to Bull Board)

- [ ] **Step 1: Add METERING queue name**

In `packages/queue/src/queues.ts`, add to `QUEUE_NAMES`:

```typescript
export const QUEUE_NAMES = {
  CRAWL: 'spatula.crawl',
  EXTRACT: 'spatula.extract',
  SCHEMA_EVOLUTION: 'spatula.schema-evolution',
  RECONCILIATION: 'spatula.reconciliation',
  EXPORT: 'spatula.export',
  WEBHOOK: 'spatula.webhooks',
  METERING: 'spatula.metering',
} as const;
```

- [ ] **Step 2: Write metering worker tests**

`packages/queue/tests/unit/metering-worker.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { processMeteringJob } from '../../src/metering-worker.js';

function createMockDeps(records: any[] = []) {
  return {
    usageRecordRepo: {
      getUnreported: vi.fn().mockResolvedValue(records),
      markReported: vi.fn().mockResolvedValue(undefined),
    },
    stripeClient: {
      isConfigured: () => true,
      reportUsage: vi.fn().mockResolvedValue(undefined),
      getSubscription: vi.fn().mockResolvedValue({
        items: { data: [{ id: 'si_1' }] },
      }),
    },
    tenantRepo: {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_1', plan: 'starter' }),
    },
  };
}

describe('processMeteringJob', () => {
  it('reports usage to Stripe and marks records as reported', async () => {
    const records = [
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 100 },
      { id: 'r2', tenantId: 'tenant-1', dimension: 'pages', quantity: 200 },
    ];
    const deps = createMockDeps(records);
    await processMeteringJob(deps as any);
    expect(deps.usageRecordRepo.getUnreported).toHaveBeenCalled();
    expect(deps.usageRecordRepo.markReported).toHaveBeenCalledWith(['r1', 'r2']);
  });

  it('skips when Stripe is not configured', async () => {
    const deps = createMockDeps([]);
    deps.stripeClient.isConfigured = () => false;
    await processMeteringJob(deps as any);
    expect(deps.usageRecordRepo.getUnreported).not.toHaveBeenCalled();
  });

  it('handles empty unreported records', async () => {
    const deps = createMockDeps([]);
    await processMeteringJob(deps as any);
    expect(deps.usageRecordRepo.getUnreported).toHaveBeenCalled();
    expect(deps.usageRecordRepo.markReported).not.toHaveBeenCalled();
  });

  it('skips tenants without Stripe customer ID', async () => {
    const records = [{ id: 'r1', tenantId: 'tenant-no-stripe', dimension: 'pages', quantity: 100 }];
    const deps = createMockDeps(records);
    deps.tenantRepo.findById.mockResolvedValue({
      id: 'tenant-no-stripe',
      stripeCustomerId: null,
      plan: 'free',
    });
    await processMeteringJob(deps as any);
    // Should still mark as reported (to avoid re-processing) but skip Stripe call
    expect(deps.stripeClient.reportUsage).not.toHaveBeenCalled();
    expect(deps.usageRecordRepo.markReported).toHaveBeenCalledWith(['r1']);
  });
});
```

- [ ] **Step 3: Implement metering worker**

`packages/queue/src/metering-worker.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { UsageRecordRepository } from '@spatula/db';
import type { TenantRepository } from '@spatula/db';

const logger = createLogger('metering-worker');

/** Duck-typed Stripe client interface — avoids cross-package import from apps/api */
export interface MeteringStripeClient {
  isConfigured(): boolean;
  reportUsage(subscriptionItemId: string, quantity: number): Promise<void>;
  getSubscription(customerId: string): Promise<{ items: { data: Array<{ id: string }> } } | null>;
}

export interface MeteringDeps {
  usageRecordRepo: UsageRecordRepository;
  tenantRepo: TenantRepository;
  stripeClient: MeteringStripeClient;
}

/**
 * Process unreported usage records and report them to Stripe.
 * Runs as an hourly BullMQ repeatable job.
 *
 * Algorithm:
 * 1. Fetch up to 1000 unreported records
 * 2. Group by tenant+dimension
 * 3. For each tenant: look up Stripe subscription item
 * 4. Report aggregated usage per dimension
 * 5. Mark records as reported
 */
export async function processMeteringJob(deps: MeteringDeps): Promise<void> {
  if (!deps.stripeClient.isConfigured()) {
    logger.debug('Stripe not configured — metering skipped');
    return;
  }

  const records = await deps.usageRecordRepo.getUnreported(1000);
  if (records.length === 0) {
    logger.debug('No unreported usage records');
    return;
  }

  logger.info({ count: records.length }, 'Processing unreported usage records');

  // Group by tenant
  const byTenant = new Map<string, typeof records>();
  for (const r of records) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  const reportedIds: string[] = [];

  for (const [tenantId, tenantRecords] of byTenant) {
    try {
      const tenant = await deps.tenantRepo.findById(tenantId);
      if (!tenant?.stripeCustomerId) {
        // No Stripe customer — mark as reported to avoid re-processing
        reportedIds.push(...tenantRecords.map((r) => r.id));
        logger.debug({ tenantId }, 'Tenant has no Stripe customer — skipping usage report');
        continue;
      }

      // Get subscription item ID for usage reporting
      const subscription = await deps.stripeClient.getSubscription(tenant.stripeCustomerId);
      if (!subscription?.items?.data?.[0]) {
        reportedIds.push(...tenantRecords.map((r) => r.id));
        logger.warn({ tenantId }, 'No active subscription found — skipping usage report');
        continue;
      }

      const subscriptionItemId = subscription.items.data[0].id;

      // Aggregate by dimension
      const byDimension = new Map<string, number>();
      for (const r of tenantRecords) {
        byDimension.set(r.dimension, (byDimension.get(r.dimension) ?? 0) + r.quantity);
      }

      // Report each dimension to Stripe
      for (const [dimension, total] of byDimension) {
        await deps.stripeClient.reportUsage(subscriptionItemId, total);
        logger.info({ tenantId, dimension, total }, 'Reported usage to Stripe');
      }

      reportedIds.push(...tenantRecords.map((r) => r.id));
    } catch (err) {
      logger.error(
        { tenantId, error: (err as Error).message },
        'Failed to report usage for tenant',
      );
      // Don't mark as reported — will retry next hour
    }
  }

  // Mark successfully processed records
  if (reportedIds.length > 0) {
    await deps.usageRecordRepo.markReported(reportedIds);
    logger.info({ reported: reportedIds.length, total: records.length }, 'Metering job complete');
  }
}
```

Note: The `SpatulaStripeClient` import type uses a relative path to `apps/api`. For proper decoupling, the metering worker should depend on an interface, not the concrete class. The `MeteringDeps.stripeClient` is already typed as an interface shape (duck-typed), so the worker doesn't import the concrete class. The worker entrypoint passes the actual `SpatulaStripeClient` instance at runtime.

- [ ] **Step 4: Register metering worker in worker-entrypoint.ts**

In `packages/queue/src/worker-entrypoint.ts`, add the metering worker as a repeatable job. Add after the webhook worker block (around line 152):

```typescript
import { processMeteringJob } from './metering-worker.js';
import type { MeteringDeps } from './metering-worker.js';
```

Add the worker registration:

```typescript
if (isEnabled('metering')) {
  const meteringQueue = new Queue(QUEUE_NAMES.METERING, { connection: redisOpts });

  // Add repeatable job (hourly)
  await meteringQueue.add(
    'metering',
    {},
    {
      repeat: { every: 60 * 60 * 1000 }, // every hour
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  const worker = new Worker(
    QUEUE_NAMES.METERING,
    async () => {
      // MeteringDeps will be wired from the full deps when available
      const meteringDeps: MeteringDeps = deps as any;
      await processMeteringJob(meteringDeps);
    },
    { connection: workerConnection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => void dlqHandler(job, err));
  workers.push(worker);
  logger.info({ queue: QUEUE_NAMES.METERING }, 'Metering worker started (hourly)');
}
```

Add the metering queue to the shutdown handler so it's properly closed:

```typescript
// In the shutdown function, after queues.closeAll():
if (meteringQueue) await meteringQueue.close();
```

The `meteringQueue` variable should be declared at module scope (alongside `workers`) so the shutdown handler can access it.

Also add `QUEUE_NAMES.METERING` to the heartbeat queue list:

```typescript
const enabledQueueNames = Object.entries({
  crawl: QUEUE_NAMES.CRAWL,
  'schema-evolution': QUEUE_NAMES.SCHEMA_EVOLUTION,
  reconciliation: QUEUE_NAMES.RECONCILIATION,
  export: QUEUE_NAMES.EXPORT,
  webhook: QUEUE_NAMES.WEBHOOK,
  metering: QUEUE_NAMES.METERING,
});
```

- [ ] **Step 5: Add metering queue to Bull Board**

In `apps/api/src/routes/admin-queues.ts`, the `createQueueDashboard` function takes a `SpatulaQueues` object. The metering queue isn't part of `SpatulaQueues` (it's a standalone queue created in worker-entrypoint). To add it to Bull Board, extend the function to accept optional extra queues:

```typescript
export function createQueueDashboard(queues: SpatulaQueues, extraQueues?: Queue[]) {
  // ... existing code ...
  const queueAdapters = [
    new BullMQAdapter(queues.crawl),
    new BullMQAdapter(queues.extract),
    new BullMQAdapter(queues.schemaEvolution),
    new BullMQAdapter(queues.reconciliation),
    new BullMQAdapter(queues.export),
    new BullMQAdapter(queues.webhook),
    ...(extraQueues ?? []).map((q) => new BullMQAdapter(q)),
  ];
  // ...
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @spatula/queue exec vitest run tests/unit/metering-worker.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/queue/src/queues.ts packages/queue/src/metering-worker.ts packages/queue/tests/unit/metering-worker.test.ts packages/queue/src/worker-entrypoint.ts apps/api/src/routes/admin-queues.ts
git commit -m "feat(queue): add hourly metering worker for Stripe usage reporting"
```

---

### Task 11: Wire Billing into App + Rate Limit Alignment

**Files:**

- Modify: `apps/api/src/app.ts` (register billing routes, wire deps)
- Modify: `apps/api/src/app.ts` (update quota-loading middleware to use tenant.plan for rate limit tier)

- [ ] **Step 1: Register billing routes in app.ts**

Add import:

```typescript
import { billingRoutes } from './routes/billing.js';
```

Register routes (after usage routes, before admin routes):

```typescript
// Billing routes
app.get('/api/v1/billing/*', requireScope('billing:read'));
app.post('/api/v1/billing/*', requireScope('billing:write'));
app.route('/api/v1/billing', billingRoutes());
```

Also add `billing:read` and `billing:write` as recognized scopes in the scope system.

- [ ] **Step 2: Update quota-loading middleware to use tenant.plan**

The current middleware reads `rateLimitTier` from `quotas` JSONB. With the billing system, the plan-based rate limit should come from the `plan` column, which maps to `BILLING_TIERS[plan].limits.rateLimitPerMin`. But for backward compatibility (self-hosted), fall back to the existing `quotas.rateLimitTier`.

Update the quota-loading middleware in `app.ts` (around lines 100-111):

```typescript
// Load tenant plan for rate limiting
app.use('/api/*', async (c, next) => {
  const tenantId = c.get('tenantId');
  if (tenantId && deps.tenantRepo) {
    try {
      const tenant = await deps.tenantRepo.findById(tenantId);
      // Use billing plan as rate limit tier (matches RATE_LIMIT_TIERS keys)
      c.set('rateLimitTier', tenant?.plan ?? 'free');
    } catch {
      c.set('rateLimitTier', 'free');
    }
  }
  return next();
});
```

This works because the renamed `RATE_LIMIT_TIERS` keys (`free/starter/pro/enterprise`) now match the billing plan names exactly.

- [ ] **Step 3: Run full API test suite**

```bash
pnpm --filter @spatula/api test
```

Fix any breakage from the new imports or middleware changes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat(api): wire billing routes, align rate limiting with billing plan"
```

---

### Task 12: Full Suite Verification + Regression

- [ ] **Step 1: Run all package tests**

```bash
pnpm test
```

- [ ] **Step 2: Run typecheck across workspace**

```bash
pnpm typecheck
```

- [ ] **Step 3: Fix any issues found**

Address any type errors, failing tests, or import issues.

- [ ] **Step 4: Final commit (if fixes needed)**

```bash
git commit -m "fix: address Wave 5-2 integration issues"
```

---

## Execution Summary

| Task      | Files   | Description                                                    |
| --------- | ------- | -------------------------------------------------------------- |
| 1         | 3       | Billing tier constants + types                                 |
| 2         | 1+      | Rename rate limit tiers to match billing names                 |
| 3         | 3       | Tenant schema extension (plan, stripe_customer_id) + migration |
| 4         | 5       | usage_records schema + UsageRecordRepository + tests           |
| 5         | 2       | QuotaEnforcer service + tests                                  |
| 6         | 2       | SpatulaStripeClient wrapper + tests                            |
| 7         | 3       | Billing API routes (subscription, invoices, portal) + tests    |
| 8         | 5       | Stripe webhook handler + auth bypass + tests                   |
| 9         | 1       | Export format restriction per billing tier                     |
| 10        | 5       | Metering queue + worker + tests + Bull Board                   |
| 11        | 1       | Wire billing into app, align rate limiting                     |
| 12        | 0       | Full suite verification                                        |
| **Total** | **~31** | **~12 commits**                                                |

## New Environment Variables

| Variable                | Required         | Default | Purpose                               |
| ----------------------- | ---------------- | ------- | ------------------------------------- |
| `STRIPE_SECRET_KEY`     | No (hosted only) | —       | Stripe API authentication             |
| `STRIPE_WEBHOOK_SECRET` | No (hosted only) | —       | Stripe webhook signature verification |

## Graceful Degradation (Self-Hosted)

When `STRIPE_SECRET_KEY` is not set:

- `SpatulaStripeClient.isConfigured()` returns false
- Billing routes return 503 "Billing not configured"
- Webhook route returns 503
- Metering worker is a no-op (skips processing)
- QuotaEnforcer still works — reads plan from tenant table, enforces limits
- Rate limiting still works — uses tenant.plan field (defaults to 'free')
