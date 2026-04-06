# Wave 5 Decomposition Design: Hosted Platform & Remote Operations

**Status:** Draft
**Created:** 2026-04-06
**Scope:** Decompose Wave 5 into ordered implementation sub-plans. This wave delivers the hosted SaaS platform and the CLI-to-server bridge (remote operations).

---

## 1. Overview

Wave 5 covers 2 workstreams:

- **Phase 12I:** Hosted Platform Layer — user management, billing & usage metering, admin panel, data retention & cleanup
- **Phase 13 Step 6:** Remote Operations — push configs to hosted server, pull results back, remote job lifecycle

**Strategy:** Foundation-first (user-tenant mapping + auth), then server platform features (billing, admin, retention), then remote CLI commands (push, then pull). Remote ops depend on the hosted platform existing because `spatula push` creates billable jobs on the user's hosted account.

**Baseline:** 265 test files across 7 packages at Wave 4 completion.

**Key design decision:** The JWT `tenant_id` claim approach from Wave 3 must be extended. The current `JwtAuthProvider` expects `tenant_id` directly in the JWT, but the hosted platform supports users belonging to multiple tenants. The auth middleware must resolve `user_id → tenant(s)` via the `user_tenants` table, with the tenant selection passed via `X-Tenant-Id` header when a user has multiple tenants.

---

## 2. Sub-plan Summary

| Sub-plan | Scope | Spec Sections | Est. New Files | Order |
|----------|-------|---------------|----------------|-------|
| **5-1** | User & Auth Foundation | 12: 10.1 | ~8 | 1 |
| **5-2** | Billing & Metering | 12: 10.2 | ~15 | 2 |
| **5-3** | Admin & Retention | 12: 10.3–10.4 | ~12 | 2 (parallel with 5-2) |
| **5-4** | Remote Config & Push | 13: 8.1–8.4, 9.4 | ~15 | 3 |
| **5-5** | Pull Flow | 13: 9.1–9.7 | ~10 | 4 |
| **5-6** | Deferred Items | Mixed | ~6 | 5 |

**Execution order:**

```
       ┌→ 5-2 (Billing) ──┐
5-1 →──┼→ 5-3 (Admin)  ───┼──→ 5-6 (Deferred)
       └→ 5-4 (Remote) ───┤
                           └→ 5-5 (Pull)
```

5-2, 5-3, and 5-4 can all proceed in parallel after 5-1. 5-5 requires 5-4 (remote config). 5-6 requires 5-5 (--keep-remote).

5-2 and 5-3 are independent of each other but both require 5-1. 5-4 requires only 5-1 (existing Wave 3 tenant quotas provide basic job-creation limits; full billing-integrated quotas from 5-2 are a refinement, not a prerequisite). 5-5 requires 5-4 (remote config + linked job). 5-6 requires 5-5 (--keep-remote flag).

---

## 3. Dependency Graph

```
5-1 (User & Auth Foundation)
  │  Provides: user_tenants table, JWT tenant resolution middleware,
  │            Stripe SDK installed, cursor streaming endpoint
  │
  ├──→ 5-2 (Billing & Metering)
  │      Provides: usage_records table, Stripe integration, billing endpoints,
  │                hourly metering worker, quota enforcement (all dimensions),
  │                Stripe webhook handler, rate limit per plan, export format restrictions
  │      Uses: user_tenants for plan-per-tenant, tenant quotas
  │
  ├──→ 5-3 (Admin & Retention)
  │      Provides: 11 new admin routes, admin scope guard on 3 existing routes,
  │                retention policies, cleanup worker, tenant config extension
  │      Uses: user_tenants for role-based admin access
  │
  └──→ 5-4 (Remote Config & Push) [parallel with 5-2 and 5-3]
         Provides: remote add/list/remove CLI commands, push flow,
                   job control (status/watch/pause/resume/cancel),
                   ApiDataSource class
         Uses: cursor streaming from 5-1; existing Wave 3 tenant quotas for basic job limits
         │
         └──→ 5-5 (Pull Flow)
                Provides: pull flow (9 steps), schema conflict resolution TUI,
                          incremental pull, cursor resume, entity coexistence,
                          source filtering in explorer
                Uses: ApiDataSource from 5-4, cursor endpoint from 5-1,
                      remote config from 5-4
                │
                └──→ 5-6 (Deferred Items)
                       Provides: audit logging in job-manager, spatula add dedup,
                                 reset --keep-remote, CSS table extraction
                       Uses: remote link tracking from 5-4 (for --keep-remote)
```

---

## 4. Sub-plan Details

### 4.1 Sub-plan 5-1: User & Auth Foundation

**Goal:** Establish the user-tenant relationship model and extend JWT auth to support multi-tenant users. Install Stripe SDK. Add cursor-based entity streaming endpoint.

**Deliverables:**

1. **`user_tenants` Drizzle schema** (`packages/db/src/schema/user-tenants.ts`):
   ```sql
   CREATE TABLE user_tenants (
     user_id TEXT NOT NULL,
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     role VARCHAR(20) NOT NULL DEFAULT 'member',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, tenant_id)
   );
   CREATE INDEX idx_user_tenants_user ON user_tenants(user_id);
   ```
   Roles: `owner`, `admin`, `member`. One user can belong to multiple tenants. One tenant can have multiple users.

2. **`UserTenantRepository`** (`packages/db/src/repositories/user-tenant-repository.ts`):
   - `findByUserId(userId: string): Promise<{ tenantId: string, role: string }[]>`
   - `findByTenantId(tenantId: string): Promise<{ userId: string, role: string }[]>`
   - `create(userId: string, tenantId: string, role: string): Promise<void>`
   - `updateRole(userId: string, tenantId: string, role: string): Promise<void>`
   - `remove(userId: string, tenantId: string): Promise<void>`
   - `isAdmin(userId: string, tenantId: string): Promise<boolean>` — returns true if role is `owner` or `admin`

3. **Database migration** — Drizzle migration for `user_tenants` table.

4. **JWT tenant resolution middleware update** (`apps/api/src/middleware/auth.ts`):
   - Current behavior: extract `tenant_id` from JWT claim directly.
   - New behavior: extract `user_id` (JWT `sub` claim), look up user's tenants via `UserTenantRepository.findByUserId()`.
     - If user has exactly 1 tenant → auto-select it.
     - If user has multiple tenants → require `X-Tenant-Id` header. Return 400 if missing.
     - If user has 0 tenants → return 403 (no tenant access).
   - The `X-Tenant-Id` header is validated against the user's actual tenants — can't access a tenant you don't belong to.
   - API key auth path is unchanged (tenant_id comes from the key's tenant association).
   - **`AUTH_STRATEGY=none` path is unchanged:** When `NoAuthProvider` is active, `tenantId` comes directly from the `X-Tenant-Id` header and `userId` is `'anonymous'`. The new user→tenant resolution logic activates **only** for the JWT auth strategy. The middleware must branch: `if (authResult.strategy === 'jwt') { /* resolve via user_tenants */ } else { /* use tenantId from auth result directly */ }`.

5. **Tenant auto-creation on first JWT login** — When a JWT user has 0 tenants, auto-create a tenant (plan: `free`, default quotas) + `user_tenants` entry with role `owner`. This bootstraps the hosted signup flow: auth provider creates the user, first API call creates their Free-tier tenant. The auto-created tenant gets the tenant name from the JWT `name` or `email` claim. **Race condition mitigation:** Use `INSERT INTO user_tenants ... ON CONFLICT (user_id, tenant_id) DO NOTHING` wrapped in a transaction. If two concurrent requests race, the second INSERT is a no-op and the subsequent SELECT picks up the tenant created by the first. Add a unique partial index on `user_tenants(user_id) WHERE role = 'owner'` to prevent duplicate owner tenants for the same user.

6. **Cursor-based entity streaming — extend existing endpoint** (`apps/api/src/routes/entities.ts`):
   The existing `GET /api/v1/jobs/:jobId/entities` endpoint already supports `cursor` and `since` query parameters via `EntityRepository.findByJobCursor()`. The only change needed is raising the `limit` max from 100 to 500 in the Zod pagination schema to support bulk pull batches. No new endpoint is needed — the pull flow uses the existing entity listing route with cursor pagination. Verify the `since` parameter works correctly for incremental pulls (entities created/updated after the given timestamp).

7. **Stripe SDK installation** — `pnpm add stripe` in workspace root or `packages/queue` (for metering worker) and `apps/api` (for billing endpoints). Evaluate which packages need it.

8. **AppDeps extension** — Add `userTenantRepo` to `AppDeps` in `apps/api/src/types.ts`. Wire in `apps/api/src/app.ts`.

**New env vars:** None (Stripe env vars added in 5-2).

**Spec references:** Phase 12, Section 10.1

---

### 4.2 Sub-plan 5-2: Billing & Metering

**Goal:** Integrate Stripe for usage-based billing with 4 tiers, enforce quotas across all dimensions, and meter usage hourly.

**Deliverables:**

1. **Billing tier constants** (`packages/shared/src/billing/tiers.ts`):
   ```typescript
   interface BillingTier {
     name: 'free' | 'starter' | 'pro' | 'enterprise';
     limits: {
       jobsPerMonth: number;       // 5 / 50 / 500 / Infinity
       pagesPerMonth: number;      // 1000 / 10000 / 100000 / Infinity
       llmTokensPerMonth: number;  // 100000 / 1000000 / 10000000 / Infinity
       storageMb: number;          // 100 / 1000 / 10000 / Infinity
       exportFormats: string[];    // ['json','csv'] / all / all / all
       rateLimitPerMin: number;    // 60 / 300 / 1500 / Infinity
     };
   }
   ```

2. **`usage_records` Drizzle schema** (`packages/db/src/schema/usage-records.ts`):
   ```sql
   CREATE TABLE usage_records (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     dimension VARCHAR(50) NOT NULL,
     quantity BIGINT NOT NULL,
     period_start DATE NOT NULL,
     period_end DATE NOT NULL,
     reported_to_stripe BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX idx_usage_tenant_period ON usage_records(tenant_id, period_start, dimension);
   ```
   Dimensions: `pages`, `llm_tokens`, `storage_bytes`, `jobs`.

3. **`UsageRecordRepository`** (`packages/db/src/repositories/usage-record-repository.ts`):
   - `record(tenantId, dimension, quantity): Promise<void>` — insert or increment for current period
   - `getCurrentUsage(tenantId, dimension): Promise<number>` — sum for current billing period
   - `getUnreported(limit: number): Promise<UsageRecord[]>` — records not yet sent to Stripe
   - `markReported(ids: string[]): Promise<void>`
   - `aggregateByTenant(tenantId, startDate, endDate): Promise<DimensionUsage[]>`

4. **Database migration** — Drizzle migration for `usage_records` table.

5. **Tenant schema extension** — Add `plan` field (varchar, default `'free'`) and `stripe_customer_id` (text, nullable) to `tenants` table. Migration to add columns.

6. **Quota enforcement service** (`packages/core/src/billing/quota-enforcer.ts`):
   - `checkQuota(tenantId, dimension, requested): Promise<void>` — throws `QuotaExceededError` if usage + requested > plan limit
   - Called before: job creation (jobs dimension), crawl task creation (pages), LLM calls (tokens), export creation (format check), content store writes (storage)
   - Wire into existing code paths: `job-manager.ts` (replace current simple concurrent-job check), crawl worker, LLM client wrapper, export orchestrator.

7. **Stripe integration** (`apps/api/src/billing/stripe-client.ts`):
   - Initialize Stripe client from `STRIPE_SECRET_KEY` env var
   - `createCustomer(tenantId, email): Promise<string>` — returns Stripe customer ID
   - `createPortalSession(customerId): Promise<string>` — returns portal URL
   - `getSubscription(customerId): Promise<StripeSubscription>`
   - `getInvoices(customerId, limit): Promise<StripeInvoice[]>`

8. **Billing routes** (`apps/api/src/routes/billing.ts`):
   - `GET /api/v1/billing/subscription` — current plan, usage vs limits, next invoice date
   - `GET /api/v1/billing/invoices` — past invoices from Stripe
   - `POST /api/v1/billing/portal` — create Stripe Customer Portal session, return redirect URL

9. **Stripe webhook handler** (`apps/api/src/routes/stripe-webhook.ts`):
   - `POST /api/v1/webhooks/stripe` — verify signature via `STRIPE_WEBHOOK_SECRET`
   - Handle events: `customer.subscription.updated` (plan change → update tenant.plan), `customer.subscription.deleted` (downgrade to free), `invoice.payment_failed` (flag tenant)
   - Webhook route is NOT behind auth middleware (Stripe calls it directly).

10. **Hourly metering worker** (`packages/queue/src/metering-worker.ts`):
    - BullMQ repeatable job running every hour
    - Fetches unreported `usage_records`, batches by tenant, calls `stripe.subscriptionItems.createUsageRecord()` for each
    - Marks records as reported
    - Add `METERING: 'spatula.metering'` to `QUEUE_NAMES`

11. **Rate limit tier alignment and wiring** — The existing `RATE_LIMIT_TIERS` in `packages/shared/src/auth/rate-limit-tiers.ts` uses names `free/standard/enterprise/unlimited` which don't match the billing tier names `free/starter/pro/enterprise`. Rename the existing tiers: `standard` → `starter`, `enterprise` → `pro`, `unlimited` → `enterprise`. Update all references. Then wire `apps/api/src/middleware/rate-limit.ts` to read tenant's `plan` field and select the matching rate limit tier.

12. **Export format enforcement** — In export creation flow, check tenant's plan against `exportFormats` in tier config. Free tier can only create JSON and CSV exports. Return 403 with upgrade message for restricted formats.

**New env vars:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

**Spec references:** Phase 12, Section 10.2

---

### 4.3 Sub-plan 5-3: Admin & Retention

**Goal:** Build admin API endpoints for platform operators, add retention policies, and implement the automated cleanup worker.

**Deliverables:**

1. **Admin scope guard** — Add `requireScope('admin')` middleware to the 3 existing admin routes (`admin-dlq`, `admin-queues`, `admin-workers`). Currently unprotected (the TODO at `admin-dlq.ts:17`).

2. **Admin tenant routes** (`apps/api/src/routes/admin-tenants.ts`):
   - `GET /api/v1/admin/tenants` — list all tenants with user count, plan, usage summary, created date. Supports `?plan=free&sort=usage` query params.
   - `GET /api/v1/admin/tenants/:id` — tenant detail: quota usage per dimension, user list with roles, recent jobs, plan info.
   - `PATCH /api/v1/admin/tenants/:id` — update: plan, quotas, status (active/suspended), retention config.

3. **Admin job routes** (`apps/api/src/routes/admin-jobs.ts`):
   - `GET /api/v1/admin/jobs` — list jobs across all tenants. Supports `?status=running&tenantId=...` filters.
   - `POST /api/v1/admin/jobs/:id/force-cancel` — force-cancel a stuck job. Sets status to `cancelled`, drains BullMQ jobs, logs audit event.

4. **Admin system routes** (`apps/api/src/routes/admin-system.ts`):
   - `GET /api/v1/admin/system/health` — detailed health: Postgres, Redis, each BullMQ queue (depth, active, failed), worker count, memory usage.
   - `GET /api/v1/admin/system/metrics` — key metrics: total tenants, active jobs, pages crawled today, LLM tokens today, storage used, DLQ depth.

5. **Tenant status enforcement** — When a tenant's status is `suspended`, all API calls for that tenant return 403 with message "Account suspended. Contact support." Add check in `validate-tenant` middleware.

6. **Admin DLQ cross-tenant access** — Resolve the TODO at `admin-dlq.ts:17`: when the calling user has `admin` scope, omit the `tenantId` filter to show all tenants' DLQ entries.

7. **Tenant config extension** — Add optional `retention` object to tenant config in `tenants` table (stored in existing `config` JSONB column or as new columns):
   - `completedJobsDays` (min: 7, default: 90)
   - `failedJobsDays` (min: 7, default: 30)
   - `rawPagesDays` (min: 7, default: 30)
   - `exportsDays` (min: 7, default: 30)

8. **Cleanup worker** (`packages/queue/src/cleanup-worker.ts`):
   - BullMQ repeatable job running daily at 03:00 UTC
   - **Tenant-configurable retention:** For each tenant, read retention config (or use defaults), delete expired data in batch (100 records per delete). Deletion order respects FK constraints: entities → extractions → raw_pages → exports → jobs.
   - **Non-configurable retention (system-wide):**
     - Audit logs: 365 days — delete entries older than 365 days regardless of tenant config
     - LLM usage records: 365 days — delete entries older than 365 days
     - DLQ entries: 90 days — delete resolved entries older than 90 days
   - **Content store cleanup:** After deleting expired exports, scan content store for entries not referenced by any remaining export. Delete orphaned content store entries. Uses `ContentStore.delete()` for filesystem/S3 backends.
   - `llm_usage.job_id` and `dead_letter_queue.spatula_job_id` use `ON DELETE SET NULL` — handled by Postgres automatically
   - Log cleanup statistics per tenant (records deleted by type)
   - Add `CLEANUP: 'spatula.cleanup'` to `QUEUE_NAMES`

9. **Audit log entries** — Log admin actions: tenant plan change, tenant suspension, force-cancel, retention config update. Uses existing `AuditLogger` from Wave 3.

10. **Route registration** — Register all new admin routes in `apps/api/src/app.ts` under `/api/v1/admin/` prefix with `requireScope('admin')`.

**New env vars:** None.

**Spec references:** Phase 12, Sections 10.3–10.4

---

### 4.4 Sub-plan 5-4: Remote Config & Push

**Goal:** Implement CLI remote configuration, the push flow for uploading project configs to the hosted server, and remote job lifecycle control.

**Deliverables:**

1. **Global config extension for remotes** — Extend `~/.spatula/config.yaml` schema with `remotes` section:
   ```yaml
   remotes:
     prod:
       url: https://api.spatula.dev
       apiKey: sk_live_****
     staging:
       url: https://staging.spatula.dev
       apiKey: sk_staging_****
   ```
   Update `GlobalConfigSchema` in `packages/core/src/config/types.ts`.

2. **`spatula remote add`** (`apps/cli/src/commands/remote.ts`):
   - Interactive: prompt for name, server URL, API key
   - Verify connection: `GET /health` on the remote server
   - Verify auth: call `/api/v1/billing/subscription` to confirm API key works, display plan info and usage
   - Save to `~/.spatula/config.yaml` under `remotes`

3. **`spatula remote list`** (`apps/cli/src/commands/remote.ts`):
   - Show configured remotes with URL
   - For each remote with a linked job (via `project_meta`): show job ID and status (fetched live from server)

4. **`spatula remote remove`** (`apps/cli/src/commands/remote.ts`):
   - Remove remote config from `~/.spatula/config.yaml`
   - Clear any remote link entries from `project_meta` (keys matching `remote:<name>:*`)

5. **`spatula push`** (`apps/cli/src/commands/push.ts`):
   - Resolve remote by name (from `~/.spatula/config.yaml`)
   - Transform `spatula.yaml` to `JobConfig` format using existing `yamlToJobConfig()`
   - Check for existing linked job on this remote (via `project_meta`)
     - If exists and running: prompt to cancel old job + create new, keep both, or cancel push
     - If exists and completed: create new job (no conflict)
   - Call `POST /api/v1/jobs` on remote server with the job config
   - Store link in `project_meta`: `remote:<name>:job_id`, `remote:<name>:pushed_at`, `remote:<name>:config_hash`
   - Prompt: "Start crawling now? (Y/n)" → if yes, call `POST /api/v1/jobs/:id/start`

6. **Remote job control commands** (`apps/cli/src/commands/remote.ts`):
   - `spatula remote status <name>` — fetch and display job status from linked job
   - `spatula remote pause <name>` — `POST /api/v1/jobs/:id/pause`
   - `spatula remote resume <name>` — `POST /api/v1/jobs/:id/resume`
   - `spatula remote cancel <name>` — `POST /api/v1/jobs/:id/cancel`
   - `spatula remote watch <name>` — connect to remote WebSocket for live dashboard TUI. Authentication flow: (1) call `POST /api/v1/ws-token` on remote server with API key to obtain a single-use 60-second WS token, (2) connect to `wss://<remote>/ws/jobs/<jobId>/progress?token=<wsToken>`. Uses existing `useWebSocket` hook from Wave 4-2 with the token-based auth path from Wave 3.

7. **`ApiDataSource` class** (`apps/cli/src/data-sources/api-data-source.ts`):
   - Implements `DataSource` interface from `@spatula/core`
   - Wraps `SpatulaApiClient` methods to match `DataSource` method signatures
   - Methods: `getEntities()`, `getSchema()`, `getActions()`, `getStatus()`, `approveAction()`, `rejectAction()`, `createExport()`, `downloadExport()`
   - Used by: `remote watch` (for dashboard data), pull flow (for entity fetching)

8. **SpatulaApiClient authentication support** — The existing `SpatulaApiClient` does not send `Authorization` headers. Add constructor option for API key authentication: `new SpatulaApiClient({ baseUrl, apiKey?, tenantId })`. When `apiKey` is provided, inject `Authorization: Bearer <apiKey>` header on all requests. This is required for all remote operations against the hosted server.

9. **SpatulaApiClient method extensions** — Add any missing methods needed for push/pull:
   - `startJob(jobId)`, `pauseJob(jobId)`, `resumeJob(jobId)` (if not already present)
   - `getEntitiesStream(jobId, cursor?, since?)` — for cursor-based pull (calls existing entity listing with cursor params)
   - `getSubscription()` — for remote add verification
   - `getWsToken(jobId)` — obtain WebSocket auth token for `remote watch`

9. **Command registration** — Register `remote` (with subcommands) and `push` in `apps/cli/src/index.tsx`.

**New env vars:** None (remote config is per-project in `~/.spatula/config.yaml`).

**Spec references:** Phase 13, Sections 8.1–8.4, 9.4

---

### 4.5 Sub-plan 5-5: Pull Flow

**Goal:** Implement the complete data pull flow — fetching entities, schema, and usage from the hosted server to the local project with conflict resolution, incremental support, and crash recovery.

**Deliverables:**

1. **`spatula pull`** (`apps/cli/src/commands/pull.ts`) — the full 9-step flow:
   1. Resolve remote → URL + API key + linked job ID from `project_meta`
   2. Check job status → warn if still running, offer snapshot vs wait
   3. Check for interrupted previous pull → resume from cursor in `project_meta`
   4. Fetch remote schema → compare with local, prompt for conflict resolution
   5. Fetch entities (paginated via cursor streaming endpoint):
      - Transform: strip `tenant_id`, map `job_id` → local `project_id`
      - Tag: `run.source = 'remote:<name>:<job_id>'`
      - Upsert: update if entity ID exists, insert if new
      - Save cursor to `project_meta` after each batch (checkpoint)
   6. Fetch LLM usage summary → write to local DB
   7. Create pull-run record with `status: 'pulled'` and `source: 'remote:<name>:<job_id>'`
   8. Clear cursor from `project_meta` (pull complete)
   9. Print summary: entities pulled, schema changes, usage cost

2. **Schema conflict resolution TUI** (`apps/cli/src/components/schema-conflict.tsx`):
   - Ink component showing diff between local and remote schema
   - Three options: "Use remote schema (recommended)", "Keep local schema", "Merge (keep all fields from both)"
   - If "Use remote" or "Merge": append discovered fields to `spatula.yaml` with `# Discovered by remote crawl (date):` comment

3. **Incremental pull** — When project already has pulled data:
   - Read last pull timestamp from `project_meta` (`remote:<name>:last_pull_at`)
   - Pass as `since` parameter to streaming endpoint
   - `--full` flag forces complete re-pull (clears previously-pulled entities first)

4. **Pull from running job** — When linked job is still running:
   - Prompt: "Pull current snapshot (can pull again later)" / "Wait for completion (polls every 30s)" / "Cancel"
   - If wait: poll `GET /api/v1/jobs/:id` every 30s until completed, then proceed with pull

5. **Partial pull recovery** — Pull cursor tracked in `project_meta` as `remote:<name>:pull_cursor`:
   - If present on pull start: resume from cursor (skip already-pulled entities)
   - `--restart` flag clears cursor and starts fresh
   - Cursor cleared on successful completion

6. **Entity coexistence** — Pulled entities and local entities share the `entities` table:
   - Distinguished by `run_id` → `runs.source` field (`'local'` vs `'remote:<name>:<job_id>'`)
   - Pulled entities are NOT flagged for re-extraction (no local HTML)

7. **Source filtering in explorer** — Extend `spatula explore` to support source filtering:
   - Add toggle keybinding (e.g., `[f]` for filter) cycling: All → Local only → Remote only
   - Filter passed to `DataSource.getEntities()` query

8. **`--include-extractions` and `--include-actions` flags** — Optional pull of extraction records and action history. Default: off (entities + schema + usage only).

**New env vars:** None.

**Spec references:** Phase 13, Sections 9.1–9.7

---

### 4.6 Sub-plan 5-6: Deferred Items

**Goal:** Address items deferred from earlier waves that are now unblocked.

**Deliverables:**

1. **Audit logging for `tenant.quota_exceeded`** (`packages/queue/src/job-manager.ts`):
   - Wire `AuditLogger` into `JobManager` via its dependency bundle
   - On `QuotaExceededError`, log audit event: `{ action: 'quota.exceeded', tenantId, dimension, current, max }`
   - Resolves TODO at `job-manager.ts:57`

2. **`spatula add` crawl history dedup** (`apps/cli/src/commands/add.ts`):
   - Currently deduplicates against seeds in `spatula.yaml` only
   - Extend: also check SQLite `crawl_tasks` table via `openLocalProject()` for URLs already crawled
   - Skip URLs that were already successfully crawled (status = 'completed')
   - Print: "Skipped 3 URLs already crawled"

3. **`spatula reset --keep-remote`** (`apps/cli/src/commands/reset.ts`):
   - Current `spatula reset` clears all local data
   - New `--keep-remote` flag: preserve `project_meta` entries matching `remote:*` keys
   - Allows resetting local crawl data while maintaining the link to remote jobs
   - Without flag: clear everything including remote links (current behavior)

4. **CSS extractor table extraction** (`packages/core/src/extraction/css-extractor.ts`):
   - Current CSS extractor handles headings, prices, images, links, lists
   - Add table extraction: detect `<table>` elements, extract headers + rows as structured data
   - Map table columns to schema fields when column headers match field names
   - Falls back to raw table data when no schema match

**New env vars:** None.

**Spec references:** Mixed (deferred from Waves 2-4)

---

## 5. Cross-Cutting Concerns

### 5.1 Middleware Chain Update

The auth middleware changes in 5-1 affect the middleware chain. Updated order:

```
security-headers → timeout → cors → request-context → auth (updated: user→tenant resolution) → validate-tenant (updated: suspended check) → rate-limit (updated: plan-based) → idempotency → timing → routes
```

The Stripe webhook endpoint (`/api/v1/webhooks/stripe`) must bypass auth middleware entirely — Stripe calls it directly with its own signature verification.

### 5.2 New BullMQ Queues

Two new queues added in Wave 5:

| Queue | Added In | Schedule | Purpose |
|-------|----------|----------|---------|
| `spatula.metering` | 5-2 | Hourly | Report usage to Stripe |
| `spatula.cleanup` | 5-3 | Daily 03:00 UTC | Data retention enforcement |

Bull Board (`admin-queues.ts`) must be updated to include both new queues. Total queue count: 6 (existing) + 2 = 8.

### 5.3 AppDeps Extensions

New dependencies added to `AppDeps` across Wave 5:

| Field | Type | Added In |
|-------|------|----------|
| `userTenantRepo` | `UserTenantRepository` | 5-1 |
| `usageRecordRepo` | `UsageRecordRepository` | 5-2 |
| `stripeClient` | `StripeClient` | 5-2 |
| `quotaEnforcer` | `QuotaEnforcer` | 5-2 |

### 5.4 New Environment Variables

| Variable | Required | Default | Added In |
|----------|----------|---------|----------|
| `STRIPE_SECRET_KEY` | Yes (hosted) | — | 5-2 |
| `STRIPE_WEBHOOK_SECRET` | Yes (hosted) | — | 5-2 |

Self-hosted deployments can skip Stripe config — billing features are disabled when `STRIPE_SECRET_KEY` is not set.

### 5.5 Database Migrations

| Migration | Table | Type | Added In |
|-----------|-------|------|----------|
| Create `user_tenants` | `user_tenants` | New table | 5-1 |
| Add `plan`, `stripe_customer_id` to `tenants` | `tenants` | Alter table | 5-2 |
| Create `usage_records` | `usage_records` | New table | 5-2 |

### 5.6 Self-Hosted vs Hosted

Wave 5 features should degrade gracefully for self-hosted deployments:

- **No `STRIPE_SECRET_KEY`** → billing endpoints return 503 "Billing not configured", quota enforcement falls back to tenant-level quotas (already exists from Wave 3), metering worker is a no-op
- **No auth provider configured** → `AUTH_STRATEGY=none` continues to work as before (single-tenant, no user management)
- **Remote ops** → work against any Spatula API server (self-hosted or hosted), authenticated via API key

### 5.7 Items Explicitly NOT in Wave 5

- Frontend/web UI (out of scope for all phases — API-only)
- SSO configuration UI (delegated to auth provider's dashboard)
- Stripe Customer Portal configuration (done in Stripe Dashboard, not in code)
- Custom enterprise pricing (handled manually, not via API)

---

## 6. Dependency on Wave 4 Outputs

| Wave 4 Output | Used By |
|----------------|---------|
| Auth middleware + scopes + JWT provider | 5-1 (extend JWT resolution) |
| Tenant model with quotas | 5-1 (add user_tenants), 5-2 (billing plan) |
| Rate limit middleware with tiers | 5-2 (wire to billing plan) |
| BullMQ infrastructure + worker entrypoint | 5-2 (metering), 5-3 (cleanup) |
| Bull Board (6 queues) | 5-2/5-3 (add 2 more queues) |
| Export orchestrator with format check | 5-2 (format restrictions per tier) |
| AuditLogger | 5-3 (admin audit), 5-6 (quota audit) |
| DataSource interface + LocalDataSource | 5-4 (ApiDataSource implementation) |
| SpatulaApiClient | 5-4 (extend for push/pull) |
| Global config system (~/.spatula/config.yaml) | 5-4 (add remotes section) |
| openLocalProject() utility | 5-5 (pull writes to local DB), 5-6 (add dedup) |
| Cursor pagination utilities (@spatula/shared) | 5-1 (streaming endpoint) |
| useWebSocket hook | 5-4 (remote watch) |
| ExplorerView component | 5-5 (source filtering) |
| project_meta SQLite table | 5-4 (remote link tracking), 5-5 (pull cursor) |
| Existing admin routes (DLQ, queues, workers) | 5-3 (add scope guard) |
| LLM usage table + Usage API | 5-2 (extend with dimension metering) |
