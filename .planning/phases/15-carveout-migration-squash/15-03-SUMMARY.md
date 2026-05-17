---
phase: 15-carveout-migration-squash
plan: 03
subsystem: api+core+db+queue+shared+cli
tags: [carveout, billing-strip, quota-enforcer-removal, metering-removal, rate-limit-defaults, auth-me-endpoint, tdd, inventory-deltas]

# Dependency graph
requires:
  - phase: 15-02
    provides: 18 Section A files deleted from OSS (history preserved in spatula-saas) + 5 known-broken source files for in-place strip
provides:
  - OSS TypeScript build is GREEN across all 6 packages (pnpm build exits 0)
  - All 5 Section B packages stripped of billing coupling (quote, core, queue, api, db, shared, cli)
  - GET /api/v1/auth/me endpoint replacing the CLI's old /billing/subscription probe
  - DEFAULT_RATE_LIMIT (single config-driven default) replacing 4-tier RATE_LIMIT_TIERS preset
  - tenants schema reduced to 6 columns (no plan, no stripeCustomerId, no idx_tenants_stripe_customer)
  - All 4 Plan 15-01 inventory deltas absorbed (auth.ts allowlist, api-keys.test scopes, remote-commands.test mock, db barrel)
  - Zero billing/Stripe/metering surface area in OSS (grep gate empty)
affects: [15-04, 15-05, 15-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Auth introspection endpoint pattern: GET /me returns {tenantId, scopes, subject, authenticated} from c.get('auth') without {data} envelope"
    - "Single-default rate limit pattern: replace tier presets with config-driven DEFAULT_RATE_LIMIT constant; route-level overrides deferred to config/rate-limits.yaml (Phase 16)"
    - "Inventory-delta absorption: 4 files identified in Plan 15-01 grep audit folded into the natural Section B edits (no separate task / no scope creep)"
    - "TDD for new endpoint: RED commit (test before route), GREEN commit (route + mount); 3 behavior specs covering 200/401/empty-scopes paths"
    - "Per-package isolated test verification: pnpm test (full turbo) has known cold-import 5s-timeout flake — per-package runs are the authoritative gate (Plan 15-01 deviation)"

key-files:
  created:
    - apps/api/src/routes/auth.ts
    - apps/api/tests/unit/routes/auth.test.ts
    - .planning/phases/15-carveout-migration-squash/15-03-SUMMARY.md
  modified:
    # API
    - apps/api/src/app.ts
    - apps/api/src/types.ts
    - apps/api/src/routes/admin-tenants.ts
    - apps/api/src/routes/exports.ts
    - apps/api/src/middleware/rate-limit.ts
    - apps/api/src/middleware/auth.ts
    - apps/api/tests/unit/middleware/rate-limit.test.ts
    - apps/api/tests/unit/routes/admin-tenants.test.ts
    - apps/api/tests/unit/routes/exports.test.ts
    - apps/api/tests/unit/routes/api-keys.test.ts
    # Queue
    - packages/queue/src/job-manager.ts
    - packages/queue/src/worker-deps.ts
    - packages/queue/src/worker-entrypoint.ts
    - packages/queue/src/workers/crawl-worker.ts
    - packages/queue/src/queues.ts
    - packages/queue/tests/unit/job-manager.test.ts
    - packages/queue/tests/unit/workers/crawl-worker.test.ts
    # Core
    - packages/core/src/pipeline/export-orchestrator.ts
    - packages/core/src/pipeline/types.ts
    - packages/core/src/index.ts
    # DB
    - packages/db/src/schema/tenants.ts
    - packages/db/src/schema/index.ts
    - packages/db/src/index.ts
    - packages/db/src/repositories/tenant-repository.ts
    - packages/db/tests/unit/repositories/tenant-repository.test.ts
    # Shared
    - packages/shared/src/index.ts
    - packages/shared/src/auth/rate-limit-tiers.ts
    - packages/shared/src/auth/types.ts
    - packages/shared/src/auth/quotas.ts
    - packages/shared/tests/unit/auth/quotas.test.ts
    # CLI
    - apps/cli/src/api/client.ts
    - apps/cli/src/commands/remote.ts
    - apps/cli/tests/unit/api/client-auth.test.ts
    - apps/cli/tests/unit/commands/remote.test.ts
    - apps/cli/tests/integration/remote-commands.test.ts

key-decisions:
  - "Auth subject sourced from c.get('auth').userId (existing AuthResult field); no new authSubject Variables typing needed; empty-string userId from NoAuthProvider normalized to null in response"
  - "/api/v1/auth/me returns top-level body (no { data: ... } envelope) — CLI client uses a dedicated fetch path (not the generic get() helper which strips to json.data)"
  - "Rate-limit middleware uses DEFAULT_RATE_LIMIT unconditionally; per-route overrides explicitly deferred to Phase 16 config/rate-limits.yaml"
  - "Inventory delta #1 (auth.ts SKIP_AUTH_PREFIXES) absorbed into Task 11 commit; deltas #2/#3 absorbed into Tasks 11/12 respectively; delta #4 (db barrel) absorbed into Task 8 — no separate commits"
  - "exports.ts: dropped the dead 403 response declaration from the trigger-export OpenAPI route after removing the quota-enforcer guard (was misleading since EXPORT_FORMAT_RESTRICTED can no longer be returned)"
  - "Task 9 (SQLite parity) was a no-op: schema-sqlite/ never had a tenants mirror (project-meta replaces it for local mode) — empty commit recorded per plan template"
  - "Task 10 (.env.example + OpenAPI fixtures + examples) was also a no-op — all clean by pre-cut baseline; no commit needed"

patterns-established:
  - "When a behavior-removal also makes a response-status declaration dead, remove the declaration in the same commit to keep OpenAPI spec accurate (exports.ts 403 removal)"
  - "When typecheck breaks across package boundaries (api depends on db depends on shared), commit changes in dependency order even if intermediate packages fail typecheck — Plan 15-02 established this pattern; Plan 15-03 followed it (e.g., Task 7 schema edits committed even though db barrel still pointed at deleted files; Task 8 cleared the barrel)"
  - "Per-package test runs as authoritative green-gate when pnpm test (full turbo) has known parallel-I/O flakes — record the per-package counts in this summary as the carve-out completeness signal"

requirements-completed: [CARVE-02, CARVE-04]

# Metrics
duration: ~33min
completed: 2026-05-17
---

# Phase 15 Plan 03: Section B In-Place Strip + Auth-Me Endpoint Summary

**5 packages stripped of all billing coupling, 13 atomic feat(carveout) commits landed on `feat/wave-6-1-carveout`, OSS TypeScript build is GREEN, GET /api/v1/auth/me endpoint replaces the CLI's pre-carve `/billing/subscription` probe, and all 4 Plan 15-01 inventory deltas absorbed into the natural Section B edits — final monorepo-wide grep for billing surface returns empty.**

## Performance

- **Duration:** ~33 min (started 2026-05-17T17:43:07Z, completed ~18:16:43Z)
- **Tasks:** 13 (all auto, 1 with TDD)
- **Commits:** 13 task commits + 1 TDD RED test commit = 14 new commits on `feat/wave-6-1-carveout`
- **Files modified:** 35 (2 created, 33 modified)
- **Files deleted:** 0 (pure in-place edits — Plan 15-02 handled deletions)

## Accomplishments

- **5 packages stripped of billing coupling.** apps/api, packages/queue, packages/core, packages/db, packages/shared each have zero references to `QuotaEnforcer`, `BillingUsageRecorder`, `RATE_LIMIT_TIERS`, `BILLING_TIERS`, `stripeCustomerId`, `rateLimitTier`, `usage-record-repository`, `getSubscription`, `billing:read`, `billing:write`. The OSS TypeScript build (`pnpm build`) exits 0 across all 6 packages.
- **GET /api/v1/auth/me endpoint added.** New auth-introspection route returning `{ tenantId, scopes, subject, authenticated: true }` (or 401 `UNAUTHENTICATED` when no tenant context). Mounted at `/api/v1/auth` in `app.ts`, no `requireScope` wrapper — auth-middleware presence is sufficient.
- **CLI rewired.** `client.getSubscription()` removed; `client.getAuthMe()` added (with dedicated fetch path that does not strip `{ data }`). `remote add` now calls `/auth/me` and surfaces `tenantId` + `scopes` in `RemoteAddResult` (instead of `plan`).
- **`tenants` Drizzle schema cleaned.** 6 columns remain: `id, name, config, quotas, storage_bytes_used, created_at`. Removed: `plan`, `stripeCustomerId`, `idx_tenants_stripe_customer`, `rateLimitTier` (from quotas JSONB default).
- **Rate-limit middleware simplified.** `RATE_LIMIT_TIERS` (4-tier preset) → `DEFAULT_RATE_LIMIT` (single config-driven default: 300 rpm, 10 concurrent jobs). Per-route overrides deferred to Phase 16's `config/rate-limits.yaml`.
- **AUTH_SCOPES cleaned.** Removed `billing:read` and `billing:write`. Final scope set: `jobs:{read,write}, exports:{read,write}, actions:{read,write}, tenants:admin, keys:manage, admin`.
- **All 4 Plan 15-01 inventory deltas absorbed inline.** No separate commits needed; each delta folded into the natural Section B edit that touched the same surface:
  1. `apps/api/src/middleware/auth.ts` SKIP_AUTH_PREFIXES — `/api/v1/webhooks/stripe` removed in Task 11 commit
  2. `apps/api/tests/unit/routes/api-keys.test.ts` — `billing:read` removed from scope fixture in Task 11 commit
  3. `apps/cli/tests/integration/remote-commands.test.ts` — mock sequence rewritten to /auth/me shape in Task 12 commit
  4. `packages/db/src/index.ts` — `UsageRecordRepository` + `UsageRecord` + `DimensionUsage` exports removed in Task 8 commit

## Task Commits

| Task | Description | Commit |
| ---- | ----------- | ------ |
| 1 | Unmount billing routes + plan-loading middleware from app.ts | `6ac966c` |
| 2 | Strip BILLING_TIERS + plan + usage aggregation from admin-tenants | `0d72430` |
| 3 | Remove QuotaEnforcer coupling from queue + core + api layers | `c449fcd` |
| 4 | Remove metering worker wiring + METERING queue name | `8b1dfb7` |
| 5 | Remove billing module + tier presets + billing scopes + TenantQuotas.rateLimitTier | `d123093` |
| 6 | Drop tier-based rate-limit lookup; use DEFAULT_RATE_LIMIT | `76e7577` |
| 7 | Drop plan + stripeCustomerId columns from tenants schema + repo | `e88d322` |
| 8 | Remove usage_records schema + repo exports | `e4e9bbc` |
| 9 | Confirm SQLite schema has no billing coupling (empty commit) | `7d2e818` |
| 10 | (no-op — .env.example + fixtures already clean; no commit) | — |
| 11 RED | Add failing test for /api/v1/auth/me endpoint | `acace54` |
| 11 GREEN | Add GET /api/v1/auth/me — auth introspection for API-key verification | `c10625a` |
| 12 | CLI uses /api/v1/auth/me for remote auth verification (replaces /billing/subscription) | `5ca4451` |
| 13 | Clean up residual billing coupling in admin-tenants + exports tests | `5d3b50e` |

**Plan metadata commit:** will follow this summary as the final commit.

## Test Counts (per-package isolated, post-strip)

| Package | Pre-cut (15-01) | Post-strip (15-03) | Delta | Notes |
| ------- | --------------- | ------------------ | ----- | ----- |
| `@spatula/core` | 92 files / 979 tests | 90 files / 965 tests | -2 files / -14 tests | billing/{quota-enforcer,billing-usage-recorder}.test.ts deleted in 15-02 |
| `@spatula/db` | 29 files / 328 tests | 28 files / 313 tests | -1 file / -15 tests | usage-record-repository.test.ts deleted in 15-02 |
| `@spatula/queue` | 18 files / 156 tests | 17 files / 141 tests | -1 file / -15 tests | metering-worker.test.ts deleted in 15-02 |
| `@spatula/api` | 50 files / 375 tests | 48 files / 349 tests | -2 files / -26 tests | billing.test.ts + stripe-webhook.test.ts + billing/stripe-client.test.ts deleted in 15-02; admin-tenants billing tests + exports billing tests stripped in 15-03 |
| `@spatula/shared` | 10 files / 75 tests | 10 files / 70 tests | 0 files / -5 tests | quotas.test.ts billing-tier assertions removed; tier-name tests collapsed to single DEFAULT_RATE_LIMIT test |
| `@spatula/cli` | 96 files / 832 tests | 96 files / 832 tests (736 pass + 96 skip) | 0 files / 0 tests | client-auth.test.ts swapped subscription-mock for auth-me-mock; total count unchanged |
| **TOTAL** | **295 files / 2,745 tests** | **289 files / 2,670 tests** (excluding skips: 2,574) | **-6 files / -75 tests** | All net-removed tests correspond to deleted billing surface — no regressions |

**Note on `pnpm test` (full turbo run):** Surfaces 1 known cold-import 5s-timeout flake in `packages/queue/tests/unit/exports.test.ts > exports crawl worker`. Pre-existing; documented in Plan 15-01 deviation #3 as a parallel-I/O race against vitest's default `testTimeout`. Per-package isolated runs (above) pass cleanly. Per the executor scope-boundary rule, the flake is out of scope for this plan — Plan 15-05 may revisit if it touches the queue test fixtures.

## Auth/Me Endpoint Contract (for Plan 15-05 reverse-contract test)

**Route:** `GET /api/v1/auth/me`
**Mount:** `apps/api/src/app.ts` → `app.route('/api/v1/auth', authRoutes())` (after api-keys block, before batch operations)
**Source:** `apps/api/src/routes/auth.ts`

**Response shape (200):**
```typescript
{
  tenantId: string;
  scopes: string[];
  subject: string | null;  // null when NoAuthProvider injects empty-string userId
  authenticated: true;     // literal
}
```

**Response shape (401):**
```typescript
{
  error: { code: 'UNAUTHENTICATED', message: 'No tenant context' }
}
```

**Auth requirements:** Requires `tenantId` to be set on the Hono context by upstream auth middleware. No `requireScope` wrapper — being authenticated is sufficient (no scope gate).

**CLI consumer:** `apps/cli/src/api/client.ts` `getAuthMe()` method (line ~290). Uses dedicated `fetch` path that does NOT strip `{ data }` envelope (the response is top-level, not data-wrapped).

## Files Created/Modified

**Created (2):**
- `apps/api/src/routes/auth.ts` — Hono route exporting `authRoutes()` factory; single `GET /me` handler.
- `apps/api/tests/unit/routes/auth.test.ts` — 3 behavior tests covering 200 / 401 / empty-scopes responses.

**Modified (33):** see frontmatter `key-files.modified` — 10 in apps/api (5 src + 5 tests), 7 in packages/queue (5 src + 2 tests), 3 in packages/core, 5 in packages/db (3 src + 2 tests; includes tests), 5 in packages/shared (4 src + 1 test), 5 in apps/cli (2 src + 3 tests).

## Decisions Made

- **Auth subject sourced from existing `auth.userId`, not new `authSubject` Variables typing.** The `AuthResult` already exposes `userId`. NoAuthProvider injects empty string; the route normalizes empty-string to `null` so callers see a clean `subject: null`. No need to extend `AppEnv.Variables` with a new field.
- **/auth/me response is top-level, not `{ data }`-wrapped.** Other Spatula API routes wrap successful responses in `{ data: ... }`. The CLI's generic `client.get()` helper unwraps `json.data`. For auth-me, the contract is "return these fields verbatim" — wrapping in `{ data }` would make it ambiguous whether `data: { authenticated: true }` means "authenticated" or "wrapped". The CLI client uses a dedicated fetch path (modeled on `getHealth()`) that does not strip the envelope.
- **Rate-limit defaults: 300 rpm + 10 concurrent jobs.** Matches the pre-carve `starter` tier (middle of the 4-tier preset). Free tier (60 rpm) and enterprise (∞) are no longer accessible in OSS. Per-route customization is a Phase 16 feature.
- **Inventory deltas absorbed inline (no separate commits).** Per Plan 15-01's planner note: "they are all trivial edits that follow naturally from the substrate-listed edits". Splitting them into separate commits would have added noise without diagnostic value. Each delta is mentioned in the absorbing commit's message.
- **Plan 15-03 Task 10 (.env.example + OpenAPI fixtures + examples) was a no-op.** Pre-cut audit confirms zero matches in those paths — Plan 15-01's reconciliation table already noted they were excluded. No edits + no commit needed (per Task 10 conditional clause).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Tests in admin-tenants.test.ts and exports.test.ts referenced removed billing behavior**
- **Found during:** Task 13 (full @spatula/api test run)
- **Issue:** 5 tests failed because production code had been edited per Tasks 2 + 3 + 7 (plan/usage/billing removed), but pre-existing tests still asserted the old contract: 1 test passing `plan` filter to repo, 1 test asserting `usage` field in response, 1 test expecting `updatePlan` audit log, 1 test expecting invalid-plan 400, 1 test expecting `EXPORT_FORMAT_RESTRICTED` 403.
- **Fix:** Updated test mocks + assertions to match new contract (admin-tenants: drop `plan` from SAMPLE_TENANT, drop `usageRecordRepo` mock, refit `findAll`/`countAll` call expectations, drop `updatePlan`/invalid-plan/no-config-payload tests; exports: replace 3-test billing block with 2-test "format availability" block confirming all formats now succeed).
- **Files modified:** `apps/api/tests/unit/routes/admin-tenants.test.ts`, `apps/api/tests/unit/routes/exports.test.ts`
- **Verification:** All 48 @spatula/api test files now pass (349 tests total, was 375 pre-cut — 26 billing-test drop is expected and matches the removed surface).
- **Committed in:** `5d3b50e` (Task 13 commit)

**2. [Rule 1 - Bug] CLI unit test in remote.test.ts asserted result.plan (removed field)**
- **Found during:** Task 12 (CLI test run after rewiring remote add)
- **Issue:** `tests/unit/commands/remote.test.ts > saves remote config after verifying health and auth` asserted `result.plan === 'starter'`, but the new `RemoteAddResult` exposes `tenantId` + `scopes` instead.
- **Fix:** Updated the test mock sequence to return the /auth/me shape (`{ tenantId, scopes, subject, authenticated }`) and asserted the new fields.
- **Files modified:** `apps/cli/tests/unit/commands/remote.test.ts`
- **Verification:** 15/15 remote.test.ts tests pass; 6/6 client-auth.test.ts tests pass; 12/12 remote-commands integration tests pass.
- **Committed in:** `5ca4451` (Task 12 commit, alongside the production rewire)

**3. [Rule 2 - Missing Functionality] exports.ts trigger-export route declared a 403 response that could no longer be returned**
- **Found during:** Task 3 (after removing the quota-enforcer guard from the trigger-export handler)
- **Issue:** The OpenAPI route declaration still listed `403: jsonContent(errorResponseSchema, 'Export format not available on current plan')` even though the only code path that produced that status was deleted. Leaving the dead declaration would have misled SDK consumers and OpenAPI doc readers.
- **Fix:** Removed the 403 entry from `triggerExportRoute.responses`. Kept the `errorResponseSchema` import (still used by other route declarations in the same file).
- **Files modified:** `apps/api/src/routes/exports.ts`
- **Verification:** `pnpm --filter @spatula/api build` exits 0 with no warnings.
- **Committed in:** `c449fcd` (Task 3 commit)

### Documented (not auto-fixed; out of scope)

**4. Cold-import 5s-timeout in `packages/queue/tests/unit/exports.test.ts > exports crawl worker` under full `pnpm test` parallel turbo run**
- **Found during:** Task 13 (initial full `pnpm test` invocation)
- **Issue:** Same flake documented in Plan 15-01 deviation #3. Under parallel turbo I/O pressure, the first dynamic `await import('../../src/index.js')` exceeds vitest's default 5-second `testTimeout`. Cached imports complete in <100ms.
- **Decision:** Pre-existing flake unrelated to the carve-out — per-package isolated run completes in 1.13s (passes cleanly). Per scope boundary, not fixing here; Plan 15-05 may revisit if it touches the queue test fixtures. The 6-package isolated test totals above are the authoritative green-gate.
- **Files modified:** None.

**5. `ExportJobPayload` import in `apps/api/src/types.ts` line 18 is unused but harmless**
- **Found during:** Task 3 (after stripping `quotaEnforcer` + `usageRecordRepo` + `stripeClient` from AppDeps)
- **Issue:** The import line `import type { JobManager, ExportJobPayload, SpatulaQueues } from '@spatula/queue';` still imports `ExportJobPayload` even though no AppDeps field references it post-strip. TypeScript's `verbatimModuleSyntax` does not flag unused type imports as errors.
- **Decision:** Out of scope for this plan — purely cosmetic, no behavioral or build impact. Flagged for whoever next touches the file (likely Plan 16 work on OpenAPI / SDK types). Not auto-fixed because it's not "essential for correctness, security, or basic operation" (Rule 2 trigger).
- **Files modified:** None (documentation only).

---

**Total deviations:** 5 documented (3 auto-fixed Rule-1/Rule-2; 2 out-of-scope: 1 pre-existing flake + 1 cosmetic unused import). **Impact on plan:** All auto-fixes follow naturally from the substrate edits (removed surface → removed tests). Out-of-scope items are explicitly bounded.

## Issues Encountered

- **Test triage required for 5 admin-tenants + exports tests.** Anticipated in the plan's verification section, handled in Task 13 as residual-coupling cleanup. No surprise — substrate Tasks 5 + 7 changed handler contracts; pre-existing tests had to follow.
- **`pnpm test` full-turbo run flake (queue exports.test.ts).** Documented in Plan 15-01; recurred here as expected. Per-package isolated runs were used as the green-gate.

## Authentication Gates

None during this plan — no auth/network/secrets operations.

## User Setup Required

None — Plan 15-03 is fully automated. Plan 15-04 (migration squash) requires no additional user setup either.

## Known Stubs

None — no UI-rendering placeholder values introduced. The new auth route returns real auth context from middleware-set state. `RemoteAddResult.tenantId` + `scopes` carry real data from the /auth/me probe.

## Next Phase Readiness

**Ready for Plan 15-04 (migration squash to `000_v1_baseline.sql`).**

- Branch `feat/wave-6-1-carveout` tip at `5d3b50e` (will advance to plan-metadata commit after this SUMMARY).
- OSS TypeScript build is GREEN: `pnpm build` exits 0 across all 6 packages.
- Per-package test counts recorded above as the post-Section-B baseline.
- New `tenants` schema (6 columns) is what Plan 15-04 will materialize as `000_v1_baseline.sql` baseline.
- `apps/api/src/routes/auth.ts` contract documented above for Plan 15-05's reverse-contract test to reference.
- Plan 15-06 (CARVE-04 final grep gate) will re-verify zero billing residues monorepo-wide; this plan's grep already confirms empty.

## Self-Check: PASSED

- [x] `apps/api/src/routes/auth.ts` — FOUND on disk
- [x] `apps/api/tests/unit/routes/auth.test.ts` — FOUND on disk
- [x] Commit `6ac966c` (Task 1) — FOUND in git log
- [x] Commit `0d72430` (Task 2) — FOUND in git log
- [x] Commit `c449fcd` (Task 3) — FOUND in git log
- [x] Commit `8b1dfb7` (Task 4) — FOUND in git log
- [x] Commit `d123093` (Task 5) — FOUND in git log
- [x] Commit `76e7577` (Task 6) — FOUND in git log
- [x] Commit `e88d322` (Task 7) — FOUND in git log
- [x] Commit `e4e9bbc` (Task 8) — FOUND in git log
- [x] Commit `7d2e818` (Task 9) — FOUND in git log
- [x] Commit `acace54` (Task 11 RED) — FOUND in git log
- [x] Commit `c10625a` (Task 11 GREEN) — FOUND in git log
- [x] Commit `5ca4451` (Task 12) — FOUND in git log
- [x] Commit `5d3b50e` (Task 13) — FOUND in git log
- [x] `pnpm build` exits 0 (verified at Task 13)
- [x] Final monorepo grep `(BILLING_TIERS|RATE_LIMIT_TIERS|QuotaEnforcer|BillingUsageRecorder|stripeCustomerId|rateLimitTier|usage-record-repository|getSubscription)` in apps/ + packages/ + tests/ returns empty (excluding node_modules + dist)
- [x] All 6 packages pass tests in isolation (totals: core 965, db 313, queue 141, shared 70, api 349, cli 736 pass)
- [x] /api/v1/auth/me handler exists and is mounted (grep `authRoutes` in app.ts returns 2)
- [x] CLI `getAuthMe` exists (grep returns ≥3 across client.ts + remote.ts + client-auth.test.ts)
- [x] `tenants` schema has 6 columns (id, name, config, quotas, storage_bytes_used, created_at) — no plan, no stripeCustomerId, no idx_tenants_stripe_customer

---
*Phase: 15-carveout-migration-squash*
*Completed: 2026-05-17*
