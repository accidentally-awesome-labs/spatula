# Wave 6-1 — Carve-out & Migration Squash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract billing / Stripe / metering code from the OSS repo into a new private `spatula-saas` repo (with preserved history for moved files), strip residual coupling, squash OSS migrations into a single v1 baseline, and prove via new test suites that the OSS-only server still satisfies the remote push/pull contract and that the private-consumer TS surface is tracked.

**Architecture:** Identify every billing-coupled file (inventoried below), move files via `git filter-repo` into the private repo, delete from OSS main forward (no history rewrite on OSS — see spec §3.1.4), edit remaining coupling in-place, squash migrations to `000_v1_baseline.sql` with a namespaced tracking table, add two new test suites (`tests/carveout/` forward + `tests/private-contract/` reverse), and produce the 5-package private-contract doc. All tests green by end; CLI push/pull against OSS-only server passes end-to-end.

**Tech Stack:** TypeScript (ESM), Turborepo + pnpm workspaces, Hono, Drizzle ORM (Postgres), BullMQ, Vitest, `git filter-repo`.

---

## Prerequisites (human-executed, before Task 1)

These must be complete before any task in this plan runs. They are outside the PR's diff.

1. **Create the private GitHub repo** `accidentallyawesomelabs/spatula-saas` (empty, no README). Give the CI automation account write access.
2. **Install `git filter-repo`** locally: `brew install git-filter-repo` or equivalent.
3. **Confirm working tree is clean** (`git status` shows nothing staged or unstaged) and branch is `main` at commit `42761d5` or later.
4. **Create feature branch:** `git checkout -b feat/wave-6-1-carveout`. All subsequent tasks commit on this branch. Final task opens a PR to `main`.

---

## Inventory — files affected

Produced from `grep -l 'stripe\|billing\|usage_records\|metering\|BILLING_TIERS\|RATE_LIMIT_TIERS\|QuotaEnforcer' ...` against `apps/`, `packages/`, `docs/`, `.env.example`, and test directories. Engineer should re-run the grep during Task 1 to catch anything added after this plan was authored.

### A. Move to `spatula-saas` (delete from OSS)

```
# Routes / API layer
apps/api/src/routes/billing.ts
apps/api/src/routes/stripe-webhook.ts
apps/api/src/billing/stripe-client.ts
apps/api/tests/unit/routes/billing.test.ts
apps/api/tests/unit/routes/stripe-webhook.test.ts
apps/api/tests/unit/billing/stripe-client.test.ts

# Shared billing primitives
packages/shared/src/billing/index.ts
packages/shared/src/billing/tiers.ts

# Core billing services
packages/core/src/billing/quota-enforcer.ts
packages/core/src/billing/quota-enforcer.test.ts
packages/core/src/billing/billing-usage-recorder.ts
packages/core/src/billing/billing-usage-recorder.test.ts
packages/core/src/billing/index.ts

# Queue metering worker
packages/queue/src/metering-worker.ts
packages/queue/tests/unit/metering-worker.test.ts

# DB: usage_records (Stripe metering table)
packages/db/src/schema/usage-records.ts
packages/db/src/repositories/usage-record-repository.ts
packages/db/tests/unit/repositories/usage-record-repository.test.ts
```

### B. Edit in-place (strip coupling, keep shell)

```
apps/api/src/app.ts                                   # unmount billing + stripe routes + plan-loading middleware
apps/api/src/routes/admin-tenants.ts                  # drop plan/stripeCustomerId/BILLING_TIERS
apps/api/src/routes/admin-system.ts                   # drop usage_records aggregation
apps/api/src/middleware/rate-limit.ts                 # drop RATE_LIMIT_TIERS lookup; fixed default
apps/api/src/middleware/auth.ts                       # any billing refs
apps/api/src/types.ts                                 # drop billing-related AppDeps fields if any
packages/queue/src/job-manager.ts                     # remove QuotaEnforcer coupling
packages/queue/src/worker-entrypoint.ts               # remove metering worker wiring
packages/queue/src/worker-deps.ts                     # remove quotaEnforcer field
packages/db/src/schema/tenants.ts                     # drop plan + stripeCustomerId columns + idx_tenants_stripe_customer
packages/db/src/schema/index.ts                       # drop usage-records export
packages/db/src/repositories/index.ts                 # drop UsageRecordRepository export
packages/db/src/repositories/tenant-repository.ts     # drop updatePlan, any stripe refs
packages/db/tests/unit/repositories/tenant-repository.test.ts  # drop billing-related cases
packages/shared/src/auth/rate-limit-tiers.ts          # drop tier presets; keep single default
packages/shared/src/index.ts                          # drop billing re-exports
.env.example                                          # drop STRIPE_* vars
docs/architecture.md                                  # strip any billing mentions (if present)
```

### C. Create new

```
packages/db/drizzle/000_v1_baseline.sql               # regenerated baseline (Task 19)
packages/db/drizzle/meta/0000_snapshot.json           # regenerated
packages/db/drizzle/meta/_journal.json                # regenerated
tests/carveout/forward.test.ts                        # OSS-alone verification
tests/carveout/admin-metrics-smoke.test.ts            # admin-system/metrics works
tests/carveout/openapi-shape.test.ts                  # no billing/stripe paths
tests/private-contract/oss-surface.test.ts            # mocked private-consumer test
tests/private-contract/README.md                      # brief how-to
tests/carveout/vitest.config.ts
tests/private-contract/vitest.config.ts
docs/private-contract.md                              # authoritative 5-package surface
```

### D. Migration artifacts deleted

```
packages/db/drizzle/0000_previous_nova.sql
packages/db/drizzle/0001_good_shotgun.sql
packages/db/drizzle/0002_far_arachne.sql
packages/db/drizzle/0003_easy_silk_fever.sql
packages/db/drizzle/0004_faithful_sauron.sql
packages/db/drizzle/0005_talented_triathlon.sql
packages/db/drizzle/0006_spicy_human_robot.sql
packages/db/drizzle/0007_loving_black_tom.sql
packages/db/drizzle/0008_past_ted_forrester.sql
packages/db/drizzle/0009_needy_tempest.sql
packages/db/drizzle/0010_melodic_dormammu.sql
packages/db/drizzle/0011_young_boomer.sql
packages/db/drizzle/meta/*.json                       # all existing snapshots
```

---

## Task 1: Take pre-cut snapshot + re-verify inventory

**Files:**
- Create: `docs/superpowers/plans/6-1-snapshot-pre-cut.md`

- [ ] **Step 1: Capture test baseline**

```bash
cd /Users/salar/Projects/spatula
pnpm install
pnpm --filter @spatula/db build  # migrations ready
pnpm test 2>&1 | tee /tmp/test-baseline-pre-cut.log
pnpm --filter @spatula/api typecheck
pnpm --filter @spatula/queue typecheck
pnpm --filter @spatula/db typecheck
```

Capture: total test count, pass/fail. Expected: all pass (Wave 5 baseline).

- [ ] **Step 2: Re-run the coupling grep to catch anything since inventory was authored**

```bash
grep -rln --include='*.ts' 'stripe\|Stripe\|BILLING_TIERS\|RATE_LIMIT_TIERS\|QuotaEnforcer\|BillingUsageRecorder\|metering\|usageRecords\|usage_records\|usage-record-repository' \
  apps/ packages/ tests/ | grep -v '/node_modules/' | grep -v '/dist/' | sort > /tmp/billing-coupling.txt
cat /tmp/billing-coupling.txt
```

If any file appears that is NOT in the plan's inventory (sections A or B), **stop and add it to the plan** before proceeding.

- [ ] **Step 3: Write a short snapshot note**

```bash
cat > docs/superpowers/plans/6-1-snapshot-pre-cut.md <<'EOF'
# 6-1 Pre-cut snapshot — <date>

## Test baseline
- Total tests: <N>
- Status: all pass

## Billing coupling grep
(contents of /tmp/billing-coupling.txt)

## Pre-cut branch tip
$(git rev-parse HEAD)
EOF
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/6-1-snapshot-pre-cut.md
git commit -m "docs(6-1): pre-cut snapshot + coupling grep baseline"
```

---

## Task 2: Extract billing history to `spatula-saas` via `git filter-repo`

**Purpose:** Produce the private repo with preserved history for only the moved files. Operates on a **clone**, never the working repo.

- [ ] **Step 1: Create a mirror clone for extraction**

```bash
cd /tmp
rm -rf spatula-mirror
git clone --mirror /Users/salar/Projects/spatula spatula-mirror
cd spatula-mirror
```

- [ ] **Step 2: Write the path-allowlist file**

```bash
cat > /tmp/saas-paths.txt <<'EOF'
apps/api/src/routes/billing.ts
apps/api/src/routes/stripe-webhook.ts
apps/api/src/billing/stripe-client.ts
apps/api/tests/unit/routes/billing.test.ts
apps/api/tests/unit/routes/stripe-webhook.test.ts
apps/api/tests/unit/billing/stripe-client.test.ts
packages/shared/src/billing/index.ts
packages/shared/src/billing/tiers.ts
packages/core/src/billing/quota-enforcer.ts
packages/core/src/billing/quota-enforcer.test.ts
packages/core/src/billing/billing-usage-recorder.ts
packages/core/src/billing/billing-usage-recorder.test.ts
packages/core/src/billing/index.ts
packages/queue/src/metering-worker.ts
packages/queue/tests/unit/metering-worker.test.ts
packages/db/src/schema/usage-records.ts
packages/db/src/repositories/usage-record-repository.ts
packages/db/tests/unit/repositories/usage-record-repository.test.ts
docs/superpowers/plans/2026-04-06-wave-5-2-billing-metering.md
EOF
```

- [ ] **Step 3: Run `git filter-repo` to keep only those paths**

```bash
cd /tmp/spatula-mirror
git filter-repo --paths-from-file /tmp/saas-paths.txt --force
```

Expected: outputs `Rewritten X commits`; remaining HEAD contains only the listed paths plus their parent directories.

- [ ] **Step 4: Verify the filtered tree**

```bash
git log --oneline | head -20
git ls-files | sort
```

Expected: `git ls-files` returns only paths from the allowlist. Log retains historical commits that touched those paths.

- [ ] **Step 5: Push to the private repo**

```bash
# Assumes the empty private repo exists (prerequisite step)
git remote add saas git@github.com:accidentallyawesomelabs/spatula-saas.git
git push --mirror saas
```

Expected: push succeeds; `spatula-saas` on GitHub now contains history for the billing files only.

- [ ] **Step 6: Commit evidence note in OSS repo**

```bash
cd /Users/salar/Projects/spatula
cat > docs/superpowers/plans/6-1-filter-repo-evidence.md <<'EOF'
# 6-1 filter-repo extraction evidence — <date>

Extracted paths (see /tmp/saas-paths.txt):
<paste list from step 2>

Commits carried over: <N> (from `git log --oneline | wc -l` on mirror)
Private repo URL: github.com/accidentallyawesomelabs/spatula-saas
Pushed: <timestamp>
EOF

git add docs/superpowers/plans/6-1-filter-repo-evidence.md
git commit -m "docs(6-1): filter-repo extraction evidence for spatula-saas"
```

---

## Task 3: Unmount billing + stripe routes from `app.ts`

**Files:**
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Open `apps/api/src/app.ts` and remove the billing route imports**

Delete these two import lines:

```typescript
import { billingRoutes } from './routes/billing.js';
import { stripeWebhookRoutes } from './routes/stripe-webhook.js';
```

- [ ] **Step 2: Remove the plan-loading middleware block**

Locate and delete the block (currently lines ~104-120 in app.ts):

```typescript
  // Load tenant plan for rate limiting (plan name matches RATE_LIMIT_TIERS keys)
  app.use('/api/*', async (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId && deps.tenantRepo) {
      try {
        const tenant = await deps.tenantRepo.findById(tenantId);
        c.set('rateLimitTier', (tenant as any)?.plan ?? 'free');
      } catch {
        c.set('rateLimitTier', 'free');
      }
    }
    return next();
  });
```

This middleware read `tenant.plan` which no longer exists after Task 12.

- [ ] **Step 3: Remove the billing + stripe route mounts**

Delete these lines:

```typescript
  // Billing routes
  app.get('/api/v1/billing/*', requireScope('billing:read'));
  app.post('/api/v1/billing/*', requireScope('billing:write'));
  app.route('/api/v1/billing', billingRoutes());

  // Stripe webhook (no auth — uses Stripe signature verification)
  app.route('/api/v1/webhooks/stripe', stripeWebhookRoutes());
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @spatula/api typecheck
```

Expected: PASS. If it fails with unresolved references, verify you removed the imports and mounts (not just one).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "refactor(api): unmount billing + stripe-webhook routes + plan-loading middleware"
```

---

## Task 4: Delete billing + stripe route files + their tests

**Files:**
- Delete: `apps/api/src/routes/billing.ts`, `apps/api/src/routes/stripe-webhook.ts`, `apps/api/src/billing/stripe-client.ts`, `apps/api/tests/unit/routes/billing.test.ts`, `apps/api/tests/unit/routes/stripe-webhook.test.ts`, `apps/api/tests/unit/billing/stripe-client.test.ts`
- Delete empty dir: `apps/api/src/billing/`, `apps/api/tests/unit/billing/`

- [ ] **Step 1: Delete the files**

```bash
cd /Users/salar/Projects/spatula
rm apps/api/src/routes/billing.ts
rm apps/api/src/routes/stripe-webhook.ts
rm apps/api/src/billing/stripe-client.ts
rm apps/api/tests/unit/routes/billing.test.ts
rm apps/api/tests/unit/routes/stripe-webhook.test.ts
rm apps/api/tests/unit/billing/stripe-client.test.ts
rmdir apps/api/src/billing apps/api/tests/unit/billing
```

- [ ] **Step 2: Verify nothing imports from the deleted paths**

```bash
grep -rln "from.*routes/billing\|from.*routes/stripe-webhook\|from.*billing/stripe-client" apps/ packages/ tests/ --include='*.ts' || echo "clean"
```

Expected: `clean`. If anything matches, those files must also be removed or their imports stripped.

- [ ] **Step 3: Typecheck + unit tests**

```bash
pnpm --filter @spatula/api typecheck
pnpm --filter @spatula/api test
```

Expected: PASS. Unit count drops by the 3 deleted test files' worth.

- [ ] **Step 4: Commit**

```bash
git add -A apps/api/src/routes apps/api/src/billing apps/api/tests
git commit -m "refactor(api): delete billing + stripe-webhook route files + tests"
```

---

## Task 5: Strip `BILLING_TIERS` + plan handling from `admin-tenants.ts`

**Files:**
- Modify: `apps/api/src/routes/admin-tenants.ts`

- [ ] **Step 1: Remove the `BILLING_TIERS` import and the `VALID_PLANS` constant**

Delete these lines near the top:

```typescript
import { BILLING_TIERS } from '@spatula/shared';

const VALID_PLANS = Object.keys(BILLING_TIERS);
```

- [ ] **Step 2: Remove `plan` from GET `/` query and response mapping**

In the `app.get('/', ...)` handler, remove `plan` from the query-parse block and the response mapping. The `findAll` / `countAll` calls no longer take a `plan` filter:

```typescript
// Before:
const plan = c.req.query('plan');
// ...
const [tenantList, total] = await Promise.all([
  deps.tenantRepo.findAll({ plan, limit, offset }),
  deps.tenantRepo.countAll({ plan }),
]);
// ...
data: tenantList.map((t: any, i: number) => ({
  id: t.id,
  name: t.name,
  plan: t.plan,
  // ...
})),

// After:
const [tenantList, total] = await Promise.all([
  deps.tenantRepo.findAll({ limit, offset }),
  deps.tenantRepo.countAll(),
]);
// ...
data: tenantList.map((t: any, i: number) => ({
  id: t.id,
  name: t.name,
  // (no plan field)
  storageBytesUsed: t.storageBytesUsed,
  userCount: userCounts[i],
  createdAt: t.createdAt,
  config: t.config,
})),
```

- [ ] **Step 3: Remove PATCH plan-change handling**

In the `app.patch('/:id', ...)` handler, delete:
- The `plan` / `stripeCustomerId` validation block (uses `VALID_PLANS`)
- The `if (body.plan !== undefined) { await deps.tenantRepo.updatePlan(...); await deps.auditLogger... }` block

Keep config (status/retention/quotas) update logic intact.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @spatula/api typecheck
```

Expected: PASS. If `tenantRepo.findAll({ plan })` call signature errors surface, that's expected — Task 12 removes the `plan` parameter from the repo too.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin-tenants.ts
git commit -m "refactor(api): strip BILLING_TIERS + plan handling from admin-tenants"
```

---

## Task 6: Remove `QuotaEnforcer` coupling from `job-manager`

**Files:**
- Modify: `packages/queue/src/job-manager.ts`, `packages/queue/src/worker-deps.ts`
- Modify: `packages/queue/tests/unit/job-manager.test.ts`

- [ ] **Step 1: Strip QuotaEnforcer import + field from `job-manager.ts`**

Remove:
```typescript
import type { QuotaEnforcer } from '@spatula/core';
```

Remove constructor field and parameter:
```typescript
quotaEnforcer?: QuotaEnforcer;
// ...
private readonly quotaEnforcer?: QuotaEnforcer;
```

Remove the quota-check block currently starting with `// Check monthly job quota via billing-aware QuotaEnforcer` (line ~57). Keep any per-tenant concurrent-job check that uses `tenantRepo.quotas.maxConcurrentJobs` — that's config-driven and stays.

- [ ] **Step 2: Strip QuotaEnforcer from `worker-deps.ts`**

Remove import and the `quotaEnforcer?: QuotaEnforcer;` field (appears twice per grep).

- [ ] **Step 3: Update `job-manager.test.ts`** — remove tests that pass a `quotaEnforcer` and assert billing-quota behavior. Keep tests that verify config-driven concurrent-job limits.

- [ ] **Step 4: Run queue tests**

```bash
pnpm --filter @spatula/queue test
```

Expected: PASS (minus billing-quota cases).

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/job-manager.ts packages/queue/src/worker-deps.ts packages/queue/tests/unit/job-manager.test.ts
git commit -m "refactor(queue): remove QuotaEnforcer coupling from job-manager"
```

---

## Task 7: Remove metering worker wiring from `worker-entrypoint.ts`

**Files:**
- Modify: `packages/queue/src/worker-entrypoint.ts`

- [ ] **Step 1: Delete metering imports**

Remove from top of file:

```typescript
import { processMeteringJob } from './metering-worker.js';
import type { MeteringDeps } from './metering-worker.js';
```

- [ ] **Step 2: Delete metering worker construction block**

Find the `if (isEnabled('metering')) { ... }` block (mid/late in `main()`) and delete it entirely.

- [ ] **Step 3: Remove `metering` from `parseEnabledWorkers` default**

In `packages/queue/src/worker-selection.ts`, find the default worker list (e.g., `['crawl','schema','reconciliation','export','webhook','metering','cleanup']`) and drop `'metering'`. Also update any docs / comments in the same file.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @spatula/queue typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/worker-entrypoint.ts packages/queue/src/worker-selection.ts
git commit -m "refactor(queue): remove metering worker wiring from entrypoint"
```

---

## Task 8: Delete `metering-worker.ts` + test

**Files:**
- Delete: `packages/queue/src/metering-worker.ts`, `packages/queue/tests/unit/metering-worker.test.ts`

- [ ] **Step 1: Delete the files**

```bash
rm packages/queue/src/metering-worker.ts
rm packages/queue/tests/unit/metering-worker.test.ts
```

- [ ] **Step 2: Confirm nothing else imports them**

```bash
grep -rln "from.*metering-worker" packages/ apps/ tests/ --include='*.ts' || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Test the queue package**

```bash
pnpm --filter @spatula/queue test
pnpm --filter @spatula/queue typecheck
```

Expected: PASS. Test count drops by 1 file.

- [ ] **Step 4: Commit**

```bash
git add -A packages/queue/src/metering-worker.ts packages/queue/tests/unit/metering-worker.test.ts
git commit -m "refactor(queue): delete metering-worker + test"
```

---

## Task 9: Delete `packages/core/src/billing/` directory

**Files:**
- Delete: `packages/core/src/billing/quota-enforcer.ts`, `quota-enforcer.test.ts`, `billing-usage-recorder.ts`, `billing-usage-recorder.test.ts`, `index.ts`

- [ ] **Step 1: Find all `@spatula/core` imports that reference billing**

```bash
grep -rln "from '@spatula/core'" apps/ packages/ tests/ --include='*.ts' | xargs grep -l "QuotaEnforcer\|BillingUsageRecorder" || echo "clean"
```

If matches appear, these consumers were already expected to be removed (Task 6). Re-run post Task 6 to confirm `clean`.

- [ ] **Step 2: Delete the directory**

```bash
rm -r packages/core/src/billing
```

- [ ] **Step 3: Check `packages/core/src/index.ts` for billing re-exports**

```bash
grep -n "billing" packages/core/src/index.ts || echo "clean"
```

If any `export * from './billing/...'` line exists, delete it.

- [ ] **Step 4: Test + typecheck core**

```bash
pnpm --filter @spatula/core typecheck
pnpm --filter @spatula/core test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "refactor(core): delete billing/ directory (QuotaEnforcer + BillingUsageRecorder)"
```

---

## Task 10: Delete `packages/shared/src/billing/` + tier presets from auth

**Files:**
- Delete: `packages/shared/src/billing/index.ts`, `packages/shared/src/billing/tiers.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/auth/rate-limit-tiers.ts`

- [ ] **Step 1: Delete the billing directory**

```bash
rm -r packages/shared/src/billing
```

- [ ] **Step 2: Remove billing re-exports from `packages/shared/src/index.ts`**

Delete lines exporting from `./billing/...` (if any). Grep to confirm:

```bash
grep -n "billing" packages/shared/src/index.ts
```

Delete matching lines.

- [ ] **Step 3: Rewrite `rate-limit-tiers.ts` to remove tier presets**

Replace the entire file content with the primitive-only default:

```typescript
// packages/shared/src/auth/rate-limit-tiers.ts
// Per-route rate limits are configured via config/rate-limits.yaml in Wave 6-2.
// Until then, a single default limit applies to all authenticated routes.

export interface RateLimitConfig {
  requestsPerMinute: number;
  maxConcurrentJobs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  requestsPerMinute: 300,
  maxConcurrentJobs: 10,
};
```

Note: `RATE_LIMIT_TIERS` export is removed; consumers update in Task 11.

- [ ] **Step 4: Typecheck shared**

```bash
pnpm --filter @spatula/shared typecheck
```

May fail due to broken `index.ts` re-exports — fix any stale export lines.

- [ ] **Step 5: Commit**

```bash
git add -A packages/shared
git commit -m "refactor(shared): remove billing module + rate-limit tier presets"
```

---

## Task 11: Update rate-limit middleware to drop tier lookup

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts`

- [ ] **Step 1: Replace `RATE_LIMIT_TIERS` usage with `DEFAULT_RATE_LIMIT`**

Before:
```typescript
import { RATE_LIMIT_TIERS } from '@spatula/shared';
// ...
const tierName = (c.get('rateLimitTier') as string) ?? 'free';
const tier = RATE_LIMIT_TIERS[tierName] ?? RATE_LIMIT_TIERS.free;
```

After:
```typescript
import { DEFAULT_RATE_LIMIT } from '@spatula/shared';
// ...
const tier = DEFAULT_RATE_LIMIT;
```

Remove any reference to `rateLimitTier` from the `AppEnv` Variables typing (in `apps/api/src/types.ts`) if present.

- [ ] **Step 2: Typecheck + test the rate-limit middleware**

```bash
pnpm --filter @spatula/api typecheck
pnpm --filter @spatula/api test -- rate-limit
```

Expected: PASS. Update any test that set `c.set('rateLimitTier', ...)` to remove that setup — the value is no longer consulted.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/middleware/rate-limit.ts apps/api/src/types.ts
git commit -m "refactor(api): drop tier-based rate-limit lookup; use DEFAULT_RATE_LIMIT"
```

---

## Task 12: Drop `plan` + `stripeCustomerId` columns from `tenants` schema

**Files:**
- Modify: `packages/db/src/schema/tenants.ts`
- Modify: `packages/db/src/repositories/tenant-repository.ts`
- Modify: `packages/db/tests/unit/repositories/tenant-repository.test.ts`

- [ ] **Step 1: Edit `tenants.ts` schema**

Before:
```typescript
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  quotas: jsonb('quotas').notNull().default({ /* ... */ }),
  storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
  plan: varchar('plan', { length: 20 }).notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  uniqueIndex('idx_tenants_stripe_customer').on(table.stripeCustomerId),
],
);
```

After:
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
  }),
  storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

(`varchar`, `uniqueIndex` imports removed; `plan`, `stripeCustomerId`, `rateLimitTier` removed; index removed.)

- [ ] **Step 2: Edit `tenant-repository.ts`**

- Remove `updatePlan()` method.
- Remove any `.findAll({ plan })` filter parameter handling.
- Remove `.countAll({ plan })` parameter handling.
- Remove any `stripeCustomerId` references.

- [ ] **Step 3: Edit `tenant-repository.test.ts`**

- Delete test cases for `updatePlan`, plan-filtered `findAll`, `stripeCustomerId` lookup.
- Keep CRUD tests, config-update tests, storage-byte tests.

- [ ] **Step 4: Typecheck db**

```bash
pnpm --filter @spatula/db typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/tenants.ts packages/db/src/repositories/tenant-repository.ts packages/db/tests/unit/repositories/tenant-repository.test.ts
git commit -m "refactor(db): drop plan + stripeCustomerId columns from tenants schema"
```

---

## Task 13: Remove `usage_records` schema + repo + all references

**Files:**
- Delete: `packages/db/src/schema/usage-records.ts`, `packages/db/src/repositories/usage-record-repository.ts`, `packages/db/tests/unit/repositories/usage-record-repository.test.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/repositories/index.ts`

- [ ] **Step 1: Delete the three files**

```bash
rm packages/db/src/schema/usage-records.ts
rm packages/db/src/repositories/usage-record-repository.ts
rm packages/db/tests/unit/repositories/usage-record-repository.test.ts
```

- [ ] **Step 2: Remove exports from `packages/db/src/schema/index.ts`**

Delete:
```typescript
export * from './usage-records.js';
```

- [ ] **Step 3: Remove exports from `packages/db/src/repositories/index.ts`**

```bash
grep -n "usage-record\|UsageRecord" packages/db/src/repositories/index.ts
```

Delete any matching line.

- [ ] **Step 4: Confirm no remaining imports**

```bash
grep -rln "usage-records\|usageRecords\|UsageRecord" packages/ apps/ tests/ --include='*.ts' | grep -v '/node_modules/' | grep -v '/dist/' || echo "clean"
```

Expected: `clean`. If `admin-system.ts` or similar still references it, strip those in Task 14.

- [ ] **Step 5: Typecheck + test**

```bash
pnpm --filter @spatula/db typecheck
pnpm --filter @spatula/db test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/db
git commit -m "refactor(db): remove usage_records schema + repository"
```

---

## Task 14: Strip `usage_records` aggregation from `admin-system.ts`

**Files:**
- Modify: `apps/api/src/routes/admin-system.ts`

- [ ] **Step 1: Inspect current `metrics` handler**

```bash
grep -n "usage_records\|usageRecords\|UsageRecord\|metering" apps/api/src/routes/admin-system.ts
```

If there are matches, the `metrics` handler sums monthly usage by tenant — that block must go.

- [ ] **Step 2: Remove the block**

Locate the `GET /metrics` handler and delete the `usage_records`-aggregation code. The response shape must still contain `totalTenants`, `activeJobs`, `totalStorageBytes`, `dlqDepth`, `queues` per the spec's §5-3 contract. Any usage / metering sub-object is removed.

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter @spatula/api typecheck
pnpm --filter @spatula/api test -- admin-system
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin-system.ts
git commit -m "refactor(api): strip usage_records aggregation from admin-system/metrics"
```

---

## Task 15: Scrub `.env.example` + any remaining billing refs

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Find STRIPE / billing vars**

```bash
grep -n "STRIPE\|BILLING\|METERING\|SUBSCRIPTION" .env.example
```

- [ ] **Step 2: Delete matching blocks**

Remove the `# ─── Stripe / Billing ───` section header and every `STRIPE_*`, `BILLING_*`, `METERING_*` variable beneath it. If comments reference billing (e.g., in the LLM or Quota sections), clean those too.

- [ ] **Step 3: Verify clean**

```bash
grep -in "stripe\|billing\|metering\|subscription" .env.example && echo "STILL DIRTY" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "chore(env): remove Stripe + billing env vars from .env.example"
```

---

## Task 16: Refresh `docs/architecture.md` + any OpenAPI / fixture references

**Files:**
- Modify: `docs/architecture.md`
- Possibly modify: `apps/api/src/schemas/*.ts` (OpenAPI examples), `tests/e2e/fixtures/*`

- [ ] **Step 1: Search all docs + OpenAPI + fixtures for billing terms**

```bash
grep -rln --include='*.md' --include='*.ts' --include='*.json' --include='*.yaml' \
  'stripe\|billing\|Billing\|Stripe\|usage_records\|BILLING_TIERS' \
  docs/ apps/api/src/schemas/ tests/ examples/ 2>/dev/null | grep -v '/node_modules/' | grep -v '/dist/'
```

- [ ] **Step 2: For each match, strip the reference**

Rules:
- `docs/architecture.md`: remove any billing box from diagrams; keep admin / multi-tenancy mentions.
- OpenAPI schemas: any `examples:` or `description:` mentioning billing/stripe paths — update or delete.
- Test fixtures: any seed data including `plan: 'pro'` etc. — drop the field.
- `examples/*/spatula.yaml`: unlikely to reference billing but confirm.

- [ ] **Step 3: Re-grep to confirm clean**

```bash
grep -rln --include='*.md' --include='*.ts' --include='*.json' --include='*.yaml' \
  'stripe\|billing\|Stripe\|Billing\|usage_records\|BILLING_TIERS' \
  docs/ apps/api/src/schemas/ tests/ examples/ 2>/dev/null | grep -v '/node_modules/' | grep -v '/dist/' | grep -v 'docs/superpowers/specs/' | grep -v 'docs/superpowers/plans/' || echo "clean"
```

Note: historical specs + plans under `docs/superpowers/{specs,plans}/` retain references and are fine to keep.

Expected: `clean` (except the specs/plans noted).

- [ ] **Step 4: Commit**

```bash
git add -A docs/architecture.md apps/api/src/schemas tests examples
git commit -m "docs: strip billing references from architecture, OpenAPI schemas, fixtures"
```

---

## Task 17: Run full typecheck + test suite, fix any remaining coupling

**No file changes expected — this is a verification checkpoint. If anything fails, fix on a per-file basis before proceeding.**

- [ ] **Step 1: Build everything**

```bash
pnpm install
pnpm build
```

Expected: PASS. Build failures typically point to missed imports.

- [ ] **Step 2: Typecheck everything**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Unit + integration tests**

```bash
pnpm test
```

Expected: PASS. Test count is lower than pre-cut baseline by roughly (billing unit tests removed).

- [ ] **Step 4: If any failure — triage**

Common surviving coupling:
- A middleware file still importing `RATE_LIMIT_TIERS`
- An OpenAPI route-builder still referencing deleted paths
- A test fixture seeding `tenants` with `plan: 'free'`

Fix each at its source; commit per fix with message `refactor(<area>): clean up residual billing coupling post carve-out`.

- [ ] **Step 5: Commit any fixes as standalone commits**

(No final commit if nothing needed fixing.)

---

## Task 18: Regenerate migrations as `000_v1_baseline.sql`

**Files:**
- Delete: all files in `packages/db/drizzle/` except the directory itself
- Create: `packages/db/drizzle/000_v1_baseline.sql`, `packages/db/drizzle/meta/_journal.json`, `packages/db/drizzle/meta/0000_snapshot.json`

- [ ] **Step 1: Verify the schema is post-carve-out clean**

```bash
grep -rn "plan\|stripeCustomerId\|usage_records\|usageRecords" packages/db/src/schema/ | grep -v '.test.' | grep -v 'config.status' | grep -v 'config.plan' || echo "schema clean"
```

Expected: `schema clean`. (The `config` JSONB may legitimately contain `status` etc. — that's OK.)

- [ ] **Step 2: Delete old migration files + metadata**

```bash
rm packages/db/drizzle/0000_previous_nova.sql
rm packages/db/drizzle/0001_good_shotgun.sql
rm packages/db/drizzle/0002_far_arachne.sql
rm packages/db/drizzle/0003_easy_silk_fever.sql
rm packages/db/drizzle/0004_faithful_sauron.sql
rm packages/db/drizzle/0005_talented_triathlon.sql
rm packages/db/drizzle/0006_spicy_human_robot.sql
rm packages/db/drizzle/0007_loving_black_tom.sql
rm packages/db/drizzle/0008_past_ted_forrester.sql
rm packages/db/drizzle/0009_needy_tempest.sql
rm packages/db/drizzle/0010_melodic_dormammu.sql
rm packages/db/drizzle/0011_young_boomer.sql
rm -rf packages/db/drizzle/meta
```

- [ ] **Step 3: Generate the new baseline**

```bash
cd packages/db
pnpm exec drizzle-kit generate --name v1_baseline
```

Expected: produces `drizzle/0000_v1_baseline.sql` + a regenerated `meta/_journal.json` + `meta/0000_snapshot.json`. The file is named `0000_*` by Drizzle by default — acceptable. The spec's `000_v1_baseline.sql` wording is illustrative.

- [ ] **Step 4: Rename if needed to match spec**

If the tool produces `0000_v1_baseline.sql` and you want the exact `000_v1_baseline.sql` naming from the spec, rename:

```bash
mv packages/db/drizzle/0000_v1_baseline.sql packages/db/drizzle/000_v1_baseline.sql
# also edit meta/_journal.json to match
```

Default behavior (`0000_`) is acceptable — document the choice in the commit message. The key invariant is **one migration file**, not its exact prefix.

- [ ] **Step 5: Apply migration to a fresh test DB to verify**

```bash
export TEST_DATABASE_URL="postgresql://spatula:spatula@localhost:5432/spatula_migration_test"
psql "$TEST_DATABASE_URL" -c 'DROP DATABASE IF EXISTS spatula_migration_test;' 2>/dev/null
createdb spatula_migration_test
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @spatula/db exec tsx src/run-migrate.ts
psql "$TEST_DATABASE_URL" -c '\dt'
```

Expected: All post-carve-out tables present (tenants, jobs, api_keys, audit_log, dead_letter_queue, entities, entity-sources, extractions, raw_pages, crawl_tasks, actions, exports, source_trust, content, llm_usage, user_tenants, schemas). **Absent:** `usage_records`, `subscriptions`, `stripe_*`. **Tenants missing:** `plan`, `stripe_customer_id` columns.

- [ ] **Step 6: Drop the test DB**

```bash
dropdb spatula_migration_test
```

- [ ] **Step 7: Commit**

```bash
git add -A packages/db/drizzle
git commit -m "chore(db): squash migrations into 000_v1_baseline for v1.0"
```

---

## Task 19: Configure separate Drizzle `migrationsTable` for OSS

**Files:**
- Modify: `packages/db/drizzle.config.ts`
- Modify: `packages/db/src/migrate.ts`

- [ ] **Step 1: Set `migrationsTable` in `drizzle.config.ts`**

Current:
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/spatula',
  },
});
```

Update to:
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './drizzle',
  // OSS migrations tracked in a dedicated table so the private spatula-saas
  // repo can run its own `saas_*` migrations in parallel against the same
  // database via a separate tracking table (__drizzle_migrations_saas).
  // See docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.1.3.
  migrationsTable: '__drizzle_migrations_oss',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/spatula',
  },
});
```

- [ ] **Step 2: Pass `migrationsTable` to the runtime migrator**

In `packages/db/src/migrate.ts`:

Current:
```typescript
await migrate(db, { migrationsFolder: resolve(pkgRoot, 'drizzle') });
```

Update to:
```typescript
await migrate(db, {
  migrationsFolder: resolve(pkgRoot, 'drizzle'),
  migrationsTable: '__drizzle_migrations_oss',
});
```

- [ ] **Step 3: Update the migrate test**

In `packages/db/tests/unit/migrate.test.ts`, update the `migrate` assertion:

```typescript
expect(mockMigrate).toHaveBeenCalledWith(mockDb, {
  migrationsFolder: expect.stringMatching(/\/drizzle$/),
  migrationsTable: '__drizzle_migrations_oss',
});
```

- [ ] **Step 4: Run migrate tests**

```bash
pnpm --filter @spatula/db test -- migrate
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle.config.ts packages/db/src/migrate.ts packages/db/tests/unit/migrate.test.ts
git commit -m "feat(db): namespace OSS migrations via __drizzle_migrations_oss tracking table"
```

---

## Task 20: Write forward carve-out test suite

**Files:**
- Create: `tests/carveout/vitest.config.ts`, `tests/carveout/openapi-shape.test.ts`

- [ ] **Step 1: Write the vitest config**

Create `tests/carveout/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Write the OpenAPI shape test**

Create `tests/carveout/openapi-shape.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import type { AppDeps } from '../../apps/api/src/types.js';

let openapi: any;

beforeAll(async () => {
  // Minimal deps — just enough to stand up the app and get the OpenAPI doc.
  const deps: Partial<AppDeps> = {};
  const app = createApp(deps as AppDeps);
  const res = await app.request('/api/openapi.json');
  expect(res.status).toBe(200);
  openapi = await res.json();
});

describe('carve-out — OpenAPI no longer advertises billing / stripe', () => {
  it('has no path starting with /api/v1/billing', () => {
    const paths = Object.keys(openapi.paths ?? {});
    expect(paths.filter((p) => p.startsWith('/api/v1/billing'))).toEqual([]);
  });

  it('has no path matching stripe webhooks', () => {
    const paths = Object.keys(openapi.paths ?? {});
    expect(paths.filter((p) => p.includes('stripe'))).toEqual([]);
  });

  it('has no schema named Subscription, UsageRecord, or StripeEvent', () => {
    const schemas = Object.keys(openapi.components?.schemas ?? {});
    for (const forbidden of ['Subscription', 'UsageRecord', 'StripeEvent', 'BillingTier']) {
      expect(schemas).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 3: Run the test, confirm it passes**

```bash
pnpm exec vitest run --config tests/carveout/vitest.config.ts
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/carveout/
git commit -m "test(carveout): OpenAPI shape suite — no billing / stripe paths"
```

---

## Task 21: Write admin-metrics smoke test

**Files:**
- Create: `tests/carveout/admin-metrics-smoke.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/carveout/admin-metrics-smoke.test.ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import type { AppDeps } from '../../apps/api/src/types.js';

describe('carve-out — admin-system/metrics aggregates without usage_records', () => {
  it('returns a structurally valid metrics payload', async () => {
    // Stubbed deps: the handler should not crash when usage_records doesn't exist.
    const deps: Partial<AppDeps> = {
      tenantRepo: {
        countAll: async () => 0,
        getTotalStorage: async () => 0,
      } as any,
      jobRepo: {
        countAll: async () => 0,
        countByStatus: async () => 0,
      } as any,
      dlqRepo: {
        countUnresolved: async () => 0,
      } as any,
      queues: {} as any,
    };
    const app = createApp(deps as AppDeps);

    // Admin metrics requires admin scope; under AUTH_STRATEGY=none + NoAuthProvider
    // all scopes resolve. If the test fails due to scope rejection, set the
    // appropriate headers or stub authProvider. The critical assertion is that
    // the handler does not throw on usage_records absence.
    const res = await app.request('/api/v1/admin/system/metrics', {
      headers: { 'X-Tenant-Id': 'smoke' },
    });
    // Accept 200 or 401/403 depending on default auth state. The point is NOT
    // a 500 referencing usage_records.
    expect([200, 401, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('totalTenants');
      expect(body).toHaveProperty('activeJobs');
      expect(body).not.toHaveProperty('monthlyUsage');
      expect(body).not.toHaveProperty('usage_records');
    }
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm exec vitest run --config tests/carveout/vitest.config.ts tests/carveout/admin-metrics-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/carveout/admin-metrics-smoke.test.ts
git commit -m "test(carveout): admin-system/metrics smoke — no usage_records reference"
```

---

## Task 22: Write forward end-to-end push/pull carve-out test

**Files:**
- Create: `tests/carveout/forward.test.ts`
- May need: reuse existing `tests/e2e/fixtures/` helpers

- [ ] **Step 1: Review existing e2e push/pull test structure**

```bash
ls tests/e2e/
cat tests/e2e/full-pipeline.test.ts | head -60
```

Confirm the helper pattern for spinning up API + worker stack against Postgres + Redis.

- [ ] **Step 2: Write `forward.test.ts`**

The test pattern should (a) boot the OSS API + worker, (b) create a tenant via CLI / HTTP without `plan`, (c) run a minimal crawl, (d) pull results back — asserting no billing / usage_records references at any step.

```typescript
// tests/carveout/forward.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startApiServer, stopApiServer, type ApiServerHandle } from '../e2e/fixtures/server.js';
import { createTestTenant, createApiKey } from '../e2e/fixtures/tenants.js';
import { runFixtureCrawl } from '../e2e/fixtures/crawl.js';

let server: ApiServerHandle;
let tenantId: string;
let apiKey: string;

beforeAll(async () => {
  server = await startApiServer({ port: 0 });
  const t = await createTestTenant(server, { name: 'carveout-fwd' });
  tenantId = t.id;
  apiKey = await createApiKey(server, tenantId);
}, 60_000);

afterAll(async () => {
  if (server) await stopApiServer(server);
});

describe('carve-out forward — OSS-only server satisfies remote push/pull contract', () => {
  it('creates a tenant with no plan field', async () => {
    const res = await fetch(`${server.url}/api/v1/admin/tenants/${tenantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('plan');
    expect(body).not.toHaveProperty('stripeCustomerId');
  });

  it('runs a full crawl + pull round-trip against the OSS-only server', async () => {
    const result = await runFixtureCrawl(server, apiKey, { fixture: 'quickstart' });
    expect(result.entitiesExtracted).toBeGreaterThan(0);
    expect(result.status).toBe('completed');
  }, 120_000);

  it('enforces config-driven concurrent-job quota (no Stripe)', async () => {
    // quotas.maxConcurrentJobs defaults to 2 from schema
    const one = await fetch(`${server.url}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['https://example.com'], fields: [] }),
    });
    const two = await fetch(`${server.url}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['https://example.com'], fields: [] }),
    });
    const three = await fetch(`${server.url}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['https://example.com'], fields: [] }),
    });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(three.status).toBe(429);  // quota exceeded, config-driven
  });
});
```

- [ ] **Step 3: Adapt to actual fixture helper names**

The helper names `startApiServer`, `createTestTenant`, `createApiKey`, `runFixtureCrawl` are illustrative. Inspect `tests/e2e/fixtures/` or `tests/e2e/full-pipeline.test.ts` and adapt names to match what actually exists. If no fixtures exist, extract minimal ones into `tests/carveout/fixtures/` rather than inventing new patterns.

- [ ] **Step 4: Run the test**

```bash
docker compose up -d  # Postgres + Redis
pnpm exec vitest run --config tests/carveout/vitest.config.ts tests/carveout/forward.test.ts
```

Expected: PASS. If quota enforcement defaults differ from `maxConcurrentJobs=2`, adjust the assertion. The critical invariants are: (a) no `plan`, (b) crawl completes, (c) quota enforces without Stripe.

- [ ] **Step 5: Commit**

```bash
git add tests/carveout/forward.test.ts
git commit -m "test(carveout): forward end-to-end push/pull against OSS-only server"
```

---

## Task 23: Write reverse private-contract test

**Files:**
- Create: `tests/private-contract/vitest.config.ts`, `tests/private-contract/oss-surface.test.ts`, `tests/private-contract/README.md`
- Create: `docs/private-contract.md`

- [ ] **Step 1: Write the vitest config**

```typescript
// tests/private-contract/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['**/*.test.ts'], environment: 'node' },
});
```

- [ ] **Step 2: Write the OSS-surface test**

The test imports the **authoritative 5-package surface** `spatula-saas` consumes and asserts each symbol exists + has the expected call signature. This surface list mirrors `docs/private-contract.md`.

```typescript
// tests/private-contract/oss-surface.test.ts
// This test is the mocked-consumer gate: any break in the TS surface that
// spatula-saas imports surfaces here. Residual risk (SQL-level, runtime-behavior)
// is caught only by spatula-saas pre-release integration — see docs/private-contract.md.

import { describe, expect, it } from 'vitest';

describe('OSS TS surface consumed by spatula-saas', () => {
  it('exports @spatula/core pipeline orchestrators', async () => {
    const core = await import('@spatula/core');
    expect(typeof core.crawlOrchestrator).toBe('function');
    expect(typeof core.schemaOrchestrator).toBe('function');
    expect(typeof core.reconcileOrchestrator).toBe('function');
    expect(typeof core.exportOrchestrator).toBe('function');
  });

  it('exports @spatula/db repositories + connection', async () => {
    const db = await import('@spatula/db');
    expect(typeof db.createDatabasePool).toBe('function');
    expect(typeof db.TenantRepository).toBe('function');
    expect(typeof db.JobRepository).toBe('function');
    expect(typeof db.ApiKeyRepository).toBe('function');
    expect(typeof db.DlqRepository).toBe('function');
    expect(typeof db.tenants).toBe('object');  // Drizzle schema
    expect(typeof db.jobs).toBe('object');
  });

  it('exports @spatula/queue primitives', async () => {
    const q = await import('@spatula/queue');
    expect(typeof q.createQueues).toBe('function');
    expect(typeof q.QUEUE_NAMES).toBe('object');
    expect(typeof q.JobManager).toBe('function');
  });

  it('exports @spatula/shared primitives (no billing)', async () => {
    const shared = await import('@spatula/shared');
    expect(typeof shared.createLogger).toBe('function');
    expect(typeof shared.loadConfig).toBe('function');
    expect(typeof shared.DEFAULT_RATE_LIMIT).toBe('object');
    // Affirmatively assert billing is gone:
    expect((shared as any).BILLING_TIERS).toBeUndefined();
    expect((shared as any).RATE_LIMIT_TIERS).toBeUndefined();
  });

  it('exports @spatula/api createApp factory', async () => {
    const api = await import('../../apps/api/src/app.js');
    expect(typeof api.createApp).toBe('function');
  });

  it('does not export any billing/stripe symbol from any package', async () => {
    const all = {
      core: await import('@spatula/core'),
      db: await import('@spatula/db'),
      queue: await import('@spatula/queue'),
      shared: await import('@spatula/shared'),
    };
    for (const [name, mod] of Object.entries(all)) {
      const keys = Object.keys(mod);
      const forbidden = keys.filter((k) =>
        /stripe|billing|quotaEnforcer|usageRecord|metering/i.test(k),
      );
      expect(forbidden, `${name} still exports: ${forbidden.join(', ')}`).toEqual([]);
    }
  });
});
```

Adapt the specific function/symbol names (`crawlOrchestrator`, `TenantRepository`, etc.) to whatever is actually exported from each barrel after the carve-out. Run `node -e 'console.log(Object.keys(await import("@spatula/core")))'` if unsure.

- [ ] **Step 3: Write the private-contract README**

```markdown
# tests/private-contract/

Mocked-consumer contract test for the 5-package OSS surface consumed by the
private `spatula-saas` repo. Mirrors `docs/private-contract.md`.

## What this catches
- Renamed or removed exports
- Changed call shapes / type arity
- Accidentally introduced billing/stripe symbols

## What this does NOT catch (residual risk — documented in docs/private-contract.md)
- SQL-level breakage where private FK references an OSS column that changed
- Runtime-behavior changes (same signature, different returned data)
- DB-level trigger / RLS policy changes

These are caught only by spatula-saas pre-release integration.
```

- [ ] **Step 4: Write the authoritative contract doc**

```markdown
# docs/private-contract.md — OSS TypeScript surface consumed by spatula-saas

This document lists the public TS exports from OSS packages that the private
`spatula-saas` repo imports. The `tests/private-contract/` suite enforces this
surface; any change here requires a matching change in spatula-saas and a
composed-migration smoke run before OSS GA tags (see spec §3.1.6).

## Consumed packages

### @spatula/core
- `crawlOrchestrator(...)` — pipeline entrypoint
- `schemaOrchestrator(...)`
- `reconcileOrchestrator(...)`
- `exportOrchestrator(...)`

### @spatula/db
- `createDatabasePool(connectionString?)`
- Repositories: `TenantRepository`, `JobRepository`, `ApiKeyRepository`, `DlqRepository`, `UserTenantRepository`
- Drizzle schemas: `tenants`, `jobs`, `api_keys`, `user_tenants`, ... (full schema exported for FK references)

### @spatula/queue
- `createQueues(redisOpts)`
- `QUEUE_NAMES`, `DEFAULT_QUEUE_CONFIG`
- `JobManager`

### @spatula/shared
- `createLogger(name)`
- `loadConfig()`
- `DEFAULT_RATE_LIMIT`
- Auth primitives: `AuthProvider` interface, `ApiKeyAuthProvider`, `JwtAuthProvider`

### @spatula/api
- `createApp(deps: AppDeps)` — Hono app factory; spatula-saas mounts billing / subscription routes on the returned instance.
- `AppDeps` type

## Residual risk (NOT caught by the mocked test)

The `tests/private-contract/` suite is a symbol+shape check. It does not catch:
- SQL-level breakage (private FK references an OSS column whose name changed)
- Runtime-behavior changes (same function signature, different returned data shape)
- DB-level trigger / row-level-security policy changes

These failure modes are caught by:
- `spatula-saas` pre-release integration: spatula-saas CI runs against each OSS `v1.x.x-next.N` tag before OSS cuts GA.
- Composed-migration smoke in spatula-saas CI (OSS `0001_*` + private `saas_0001_*` applied together).
- Human GA-cut checklist verification in spec §8.2.

## Changing this surface

Any OSS PR that alters exports listed here MUST:
1. Update this document.
2. Update `tests/private-contract/oss-surface.test.ts` to match.
3. Open a mirror PR in `spatula-saas` to adapt the consumer.
4. Flag the change in PR description with `private-contract-change: yes` label.
```

- [ ] **Step 5: Run the test**

```bash
pnpm build
pnpm exec vitest run --config tests/private-contract/vitest.config.ts
```

Expected: PASS. If a symbol reference is wrong (e.g., real export is `createPool` not `createDatabasePool`), correct the test to match reality; the test is the contract, so what it asserts should be what spatula-saas actually imports.

- [ ] **Step 6: Commit**

```bash
git add tests/private-contract/ docs/private-contract.md
git commit -m "test(private-contract): mocked consumer surface for spatula-saas + contract doc"
```

---

## Task 24: Wire the new test directories into the root test runner

**Files:**
- Modify: `package.json` (root), possibly `turbo.json`

- [ ] **Step 1: Inspect root test script**

```bash
grep -A 5 '"test"' package.json
cat turbo.json | head -30
```

- [ ] **Step 2: Add carveout + private-contract test scripts**

In root `package.json`, add:

```json
{
  "scripts": {
    "test:carveout": "vitest run --config tests/carveout/vitest.config.ts",
    "test:private-contract": "vitest run --config tests/private-contract/vitest.config.ts",
    "test:e2e": "vitest run --config tests/e2e/vitest.config.ts"
  }
}
```

Then update the top-level `test` / `test:e2e` orchestration to include these as separate phases. If CI calls `pnpm test && pnpm test:e2e`, append `&& pnpm test:carveout && pnpm test:private-contract`.

- [ ] **Step 3: Verify CI runs them**

Inspect `.github/workflows/ci.yml`. If the `test` or `e2e` job doesn't include `test:carveout` / `test:private-contract`, add them.

- [ ] **Step 4: Commit**

```bash
git add package.json turbo.json .github/workflows/ci.yml
git commit -m "ci: wire carveout + private-contract test suites into CI"
```

---

## Task 25: Final full-suite verification + summary note

**No file changes in the first three steps — this is the pre-PR gate.**

- [ ] **Step 1: Clean install + full build + full test**

```bash
rm -rf node_modules **/node_modules **/dist
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:carveout
pnpm test:private-contract
# e2e optionally if docker services are up
docker compose up -d
pnpm test:e2e
```

Expected: all PASS. Note the new total test count.

- [ ] **Step 2: Diff summary vs. pre-cut baseline**

```bash
git diff --stat main...HEAD | tail -5
git log main..HEAD --oneline
```

Expected: ~15-25 commits on the branch, touching `apps/api`, `packages/`, `tests/carveout`, `tests/private-contract`, `docs/`, `.env.example`.

- [ ] **Step 3: Write completion summary**

```bash
cat > docs/superpowers/plans/6-1-completion-summary.md <<EOF
# 6-1 Completion Summary

**Branch:** feat/wave-6-1-carveout
**Commits:** <N>
**Test baseline (pre-cut):** <N> tests
**Test count (post-cut):** <N> tests
**Packages affected:** api, core, db, queue, shared
**New tests:** tests/carveout/ (3 files), tests/private-contract/ (1 file)
**Migration squash:** 12 files → 1 baseline
**Private repo:** accidentallyawesomelabs/spatula-saas (created + populated)
**Spec sections implemented:** §3.1, §3.1.3, §3.1.6
EOF
git add docs/superpowers/plans/6-1-completion-summary.md
git commit -m "docs(6-1): completion summary"
```

- [ ] **Step 4: Open PR**

```bash
git push -u origin feat/wave-6-1-carveout
gh pr create --base main --title "feat(6-1): carve-out billing to spatula-saas + migration squash" --body "$(cat <<'EOF'
## Summary
- Extracted billing/Stripe/metering code to private `spatula-saas` repo with preserved history (git filter-repo)
- Stripped residual coupling in admin-tenants, rate-limit middleware, job-manager, worker-entrypoint
- Dropped `plan` + `stripeCustomerId` columns from `tenants` schema; removed `usage_records` entirely
- Squashed 12 migrations into a single `000_v1_baseline.sql` with namespaced tracking table `__drizzle_migrations_oss`
- Added forward carve-out tests (`tests/carveout/`) proving OSS-only server satisfies remote push/pull contract
- Added reverse private-contract test (`tests/private-contract/`) with authoritative 5-package surface doc
- Refreshed `docs/architecture.md` and OpenAPI examples

Implements Wave 6-1 per spec `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` (§3.1, §3.1.3, §3.1.6).

## Test plan
- [x] `pnpm test` — all unit + integration green
- [x] `pnpm test:carveout` — 3 suites green
- [x] `pnpm test:private-contract` — 1 suite green
- [x] `pnpm test:e2e` — full push/pull round-trip green
- [x] Fresh migration applied to clean Postgres via `run-migrate.ts` — all non-billing tables present, billing tables absent
- [x] Coupling grep returns clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Appendix — common pitfalls

**1. Drizzle cache:** After editing schema files, `pnpm --filter @spatula/db build` before re-running `drizzle-kit generate`. Otherwise the generator uses stale compiled JS.

**2. ESM `.js` import paths:** The codebase uses the TS→JS convention: imports from `.ts` files use `.js` extensions (`import { x } from './foo.js'`). When deleting files, remove the matching `.js` import paths everywhere, not `.ts` paths.

**3. `private: true` root package — doesn't publish:** Don't worry about npm publish during 6-1; that's 6-2.

**4. Partial migrations in dev DBs:** If the engineer has a dev Postgres with old billing tables, `run-migrate.ts` against the new baseline is additive — old tables will persist. Drop the DB and re-migrate for a clean verification. **Never** try to "merge" old data into the new baseline.

**5. `apps/api/src/types.ts` stale types:** The `AppDeps` or `AppEnv` types may have `quotaEnforcer?`, `rateLimitTier?`, or `billing*?` fields. Strip them during Task 17 triage.

**6. `tenants.quotas.rateLimitTier` JSONB field:** The default value includes `rateLimitTier: 'free'`. This field is internal config, not public API. Leave it in the default for now — 6-2's per-route YAML replaces the rate-limit plumbing entirely. Do NOT write a migration to remove it; the JSONB default applies only to new rows.

**7. If `filter-repo` strips too much:** The path-allowlist technique keeps ONLY the listed paths. If `spatula-saas` ends up missing something (e.g., root `package.json` context), you can `git filter-repo` with `--path-glob` instead, or start over from the mirror clone.

---

## Self-review against spec

- [x] §3.1.1 files that move — covered in Task 2 allowlist
- [x] §3.1.2 files edited in-place — covered in Tasks 3, 5, 6, 7, 11, 12, 14, 15, 16
- [x] §3.1.3 migration squash + namespacing — covered in Tasks 18, 19
- [x] §3.1.4 history policy (no OSS rewrite) — implicit; OSS working tree deletes forward, Task 2 operates on a mirror clone
- [x] §3.1.5 private↔OSS dep model — acknowledged in docs/private-contract.md
- [x] §3.1.6 bidirectional carve-out verification — forward in Task 22; reverse in Task 23; residual risk documented
- [x] 6-1 acceptance criteria: existing tests pass (Task 17, 25); new carve-out suite passes (Tasks 20, 21, 22); CLI push/pull against OSS-only green (Task 22); admin metrics smoke (Task 21)

No gaps found. Plan ready for execution.

---

**Plan complete.** Saved to `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md`. 25 tasks, bite-sized, TDD-adjacent (carve-out is primarily removal so tests serve as the acceptance harness).
