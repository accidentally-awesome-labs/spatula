---
phase: 15-carveout-migration-squash
verified: 2026-05-17T20:45:00Z
status: passed
score: 5/5 must-haves verified
re_verification:
  is_re_verification: false
---

# Phase 15: Carve-out & Migration Squash Verification Report

**Phase Goal:** OSS-only server has zero Stripe/billing/metering surface area; pre-Wave-6 migrations collapse into a single baseline; the contract the private `spatula-saas` repo will consume is locked down with a reverse-contract test.

**Verified:** 2026-05-17T20:45:00Z
**Branch:** `feat/wave-6-1-carveout` (tip `8e7715c`, 39 commits since `main`)
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                                                                                                                 | Status     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `tests/carveout/` passes end-to-end against an OSS-only server (remote push/pull patterns, tenant CRUD without plan fields, config-driven quota enforcement, admin-metrics aggregation with no `usage_records`, OpenAPI shape clean). | ✓ VERIFIED | `pnpm test:carveout` → **7 tests / 3 files PASS** (admin-metrics-smoke, openapi-shape, forward). Forward test seeds tenant + API key, hits live server `GET /api/v1/auth/me`, `GET /admin/tenants/:id`, `GET /api/openapi.json`.                                                                                                                                                                                                                          |
| 2   | `tests/private-contract/` passes — mocked consumer importing the 5 packages breaks on silent symbol removal; `docs/private-contract.md` records residual-risk acknowledgments (SQL FK, runtime drift, RLS/trigger).                   | ✓ VERIFIED | `pnpm test:private-contract` → **22 tests / 2 files PASS** (`oss-surface.test.ts` 21 tests, `schema-lint.test.ts` 1 live-Postgres test). `docs/private-contract.md` contains explicit rows for runtime-drift, RLS/trigger, FK in the residual-risk register.                                                                                                                                                                                              |
| 3   | Fresh `pnpm db:migrate` on an empty Postgres applies exactly `0000_v1_baseline.sql` under `__drizzle_migrations_oss`; no billing tables; pre-Wave-6 dev DBs documented as wipe-and-reseed in `docs/runbooks/upgrade.md`.              | ✓ VERIFIED | Single SQL file in `packages/db/drizzle/` (`0000_v1_baseline.sql`, 280 lines, 17 `CREATE TABLE`); `migrations.table: '__drizzle_migrations_oss'` in `drizzle.config.ts`; matching `migrationsTable: '__drizzle_migrations_oss'` in `migrate.ts` + `run-migrate.ts`; `docs/runbooks/upgrade.md` contains explicit wipe-and-reseed section + dropdb/createdb/run-migrate.ts commands. Note: 280 lines vs prompt's expected 281 — within rounding tolerance. |
| 4   | `git grep -i 'stripe                                                                                                                                                                                                                  | billing    | usage_records                                                                                                                                                                                                                                                                                                                                                                                                                                             | plan: '`returns zero hits under`apps/api/`, `packages/db/`, `packages/queue/`, `.env.example`, and OpenAPI seed fixtures; `docs/architecture.md` republished with zero billing mentions. | ✓ VERIFIED | All four scopes return **0 hits** (verified via `git grep -inE` on each scope individually). `.env.example` clean. `docs/architecture.md` clean (0 hits, but contains "carve-out" and "private-contract.md" cross-refs). Historical test-fixture Stripe placeholder (sk*live*...) outside scope per prompt's note. |
| 5   | No-migration-downgrade policy + expand-contract-only schema-change rule committed to `docs/runbooks/upgrade.md` AND referenced from the carve-out PR description (PR #1).                                                             | ✓ VERIFIED | `docs/runbooks/upgrade.md` contains both policies as explicit named sections; PR #1 body references both via name (`no-migration-downgrade`, `expand-contract`) and cross-links to `docs/runbooks/upgrade.md`. PR state via `gh pr view`: `state: OPEN`, `mergeable: MERGEABLE`.                                                                                                                                                                          |

**Score:** 5/5 truths verified

### Required Artifacts (Spot-Check)

| Artifact                                             | Expected                                                                  | Status                      | Details                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/drizzle/0000_v1_baseline.sql`           | ~281 lines, 17 tables                                                     | ✓ VERIFIED                  | 280 lines (1 line off the prompt's expected 281 — non-material), 17 `CREATE TABLE` statements                                                            |
| `packages/db/drizzle.config.ts`                      | `migrations.table: '__drizzle_migrations_oss'`                            | ✓ VERIFIED                  | Found at line 13 (nested under `migrations:` block, matches drizzle-kit's nested config shape)                                                           |
| `packages/db/drizzle/meta/`                          | Regenerated journal + 0000 snapshot                                       | ✓ VERIFIED                  | `_journal.json` + `0000_snapshot.json` present                                                                                                           |
| `packages/db/src/migrate.ts` + `run-migrate.ts`      | Both use `migrationsTable: '__drizzle_migrations_oss'`                    | ✓ VERIFIED                  | Lines 17 + 11 respectively                                                                                                                               |
| `.github/workflows/migration-equivalence.yml`        | pg_dump equivalence gate                                                  | ✓ VERIFIED                  | 5 matches for `pg_dump`; YAML present                                                                                                                    |
| `scripts/normalize-schema-dump.sh`                   | Executable normalizer                                                     | ✓ VERIFIED                  | Present, executable (`-rwxr-xr-x`)                                                                                                                       |
| `scripts/migration-equivalence-expected-diff.txt`    | Expected-diff record                                                      | ✓ VERIFIED                  | 1458 bytes                                                                                                                                               |
| `tests/carveout/vitest.config.ts`                    | Vitest config                                                             | ✓ VERIFIED                  | 1114 bytes                                                                                                                                               |
| `tests/carveout/openapi-shape.test.ts`               | OpenAPI no-billing suite                                                  | ✓ VERIFIED                  | 3 tests PASS                                                                                                                                             |
| `tests/carveout/admin-metrics-smoke.test.ts`         | Admin metrics smoke                                                       | ✓ VERIFIED                  | 1 test PASS                                                                                                                                              |
| `tests/carveout/forward.test.ts`                     | Live forward suite                                                        | ✓ VERIFIED                  | 3 tests PASS against live Postgres                                                                                                                       |
| `tests/carveout/fixtures/server.ts`                  | `startCarveoutServer` + `seedTenantAndKey`                                | ✓ VERIFIED                  | Both exported and consumed by `forward.test.ts`                                                                                                          |
| `tests/private-contract/vitest.config.ts`            | Vitest config                                                             | ✓ VERIFIED                  | Present                                                                                                                                                  |
| `tests/private-contract/oss-surface.test.ts`         | 6 import-group describes + neg billing assertion                          | ✓ VERIFIED                  | 21 tests PASS                                                                                                                                            |
| `tests/private-contract/schema-lint.test.ts`         | SQL schema lint (introspect or pg_dump baseline)                          | ✓ VERIFIED                  | 1 test PASS (3426ms — runs live migration); baseline format is `.sql` (Plan B per Plan 15-05 — fallback documented) instead of `.json`                   |
| `tests/private-contract/baseline.schema.sql`         | Committed baseline                                                        | ✓ VERIFIED (with deviation) | 27512 bytes — naming differs from plan's `baseline.schema.json` because Plan 15-05's documented fallback (Plan B = pg_dump normalized baseline) was used |
| `tests/private-contract/README.md`                   | How-to-run + residual-risk pointer                                        | ✓ VERIFIED                  | 7227 bytes; contains schema-lint section                                                                                                                 |
| `apps/api/src/routes/auth.ts` + auth test            | `GET /api/v1/auth/me` returning `{tenantId,scopes,subject,authenticated}` | ✓ VERIFIED                  | Route exports `authRoutes`, mounted at `/api/v1/auth` in `app.ts:130`. Returns the expected shape with 401 on missing tenantId. Unit test file present.  |
| `docs/architecture.md`                               | Refreshed, no billing mentions                                            | ✓ VERIFIED                  | 173 lines; 0 hits for billing keywords; carve-out/private-contract.md cross-refs present                                                                 |
| `docs/private-contract.md`                           | 5-package surface + residual-risk register                                | ✓ VERIFIED                  | 153 lines; all 5 packages enumerated; residual-risk register includes runtime drift + RLS/trigger                                                        |
| `docs/runbooks/upgrade.md`                           | No-downgrade + expand-contract + wipe-and-reseed                          | ✓ VERIFIED                  | 120 lines; both policies named explicitly; wipe-and-reseed section with executable shell                                                                 |
| `docs/superpowers/plans/6-1-block01-evidence.md`     | BLOCK-01 verification                                                     | ✓ VERIFIED                  | Present                                                                                                                                                  |
| `docs/superpowers/plans/6-1-snapshot-pre-cut.md`     | Pre-cut snapshot                                                          | ✓ VERIFIED                  | Present                                                                                                                                                  |
| `docs/superpowers/plans/6-1-filter-repo-evidence.md` | filter-repo audit trail                                                   | ✓ VERIFIED                  | Present                                                                                                                                                  |
| `docs/superpowers/plans/6-1-final-grep-evidence.md`  | CARVE-04 final-gate green-state                                           | ✓ VERIFIED                  | Present                                                                                                                                                  |
| `docs/superpowers/plans/6-1-completion-summary.md`   | End-of-phase summary                                                      | ✓ VERIFIED                  | Present                                                                                                                                                  |

### Key Link Verification

| From                                            | To                                                 | Via                                                                                           | Status  | Details                                                                                     |
| ----------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `apps/api/src/app.ts`                           | `apps/api/src/routes/auth.ts`                      | `app.route('/api/v1/auth', authRoutes())`                                                     | ✓ WIRED | Import at line 33; mount at line 130                                                        |
| `apps/cli/src/commands/remote.ts`               | `GET /api/v1/auth/me`                              | `client.getAuthMe()` replacing prior `getSubscription`                                        | ✓ WIRED | CLI tests pass; Plan 15-03 SUMMARY confirms `getSubscription` removed                       |
| `apps/api/src/middleware/rate-limit.ts`         | `packages/shared` `DEFAULT_RATE_LIMIT`             | `import { DEFAULT_RATE_LIMIT }`                                                               | ✓ WIRED | Plan 15-03 Task 6 verified; tests pass                                                      |
| `packages/db/src/migrate.ts` + `run-migrate.ts` | Postgres `__drizzle_migrations_oss` tracking table | `migrate(db, { migrationsTable: '__drizzle_migrations_oss', ... })`                           | ✓ WIRED | Both files grep-confirmed; carveout forward test exercises the migrated DB                  |
| `.github/workflows/migration-equivalence.yml`   | Squash correctness gate                            | `pg_dump --schema-only` diff between sequential vs squashed (5 `pg_dump` matches in workflow) | ✓ WIRED | Workflow file present; references `0000_v1_baseline.sql`                                    |
| `.github/workflows/ci.yml`                      | `tests/carveout/` + `tests/private-contract/`      | `pnpm test:carveout` + `pnpm test:private-contract` steps                                     | ✓ WIRED | 2 matches in `ci.yml`; `pull_request` trigger present                                       |
| `tests/private-contract/schema-lint.test.ts`    | `tests/private-contract/baseline.schema.sql`       | Snapshot diff vs committed baseline                                                           | ✓ WIRED | Baseline file present (27512 bytes); schema-lint test passes against it                     |
| PR #1 description                               | `docs/runbooks/upgrade.md`                         | Explicit reference to no-migration-downgrade + expand-contract policies                       | ✓ WIRED | `gh pr view 1` body grep confirms both policy names + `docs/runbooks/upgrade.md` cross-link |
| `spatula-saas` private repo                     | Section A file history                             | `git filter-repo --paths-from-file` carrying preserved history (per evidence file)            | ✓ WIRED | `6-1-filter-repo-evidence.md` records pushed SHA + carried-commit count                     |

### Data-Flow Trace (Level 4)

| Artifact                                     | Data Variable                            | Source                                                         | Produces Real Data                                                                      | Status    |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------- |
| `apps/api/src/routes/auth.ts`                | `tenantId`, `auth.scopes`, `auth.userId` | Set by upstream `authMiddleware` (existing auth pipeline)      | Yes (real auth context flows; carveout forward test asserts seeded tenantId roundtrips) | ✓ FLOWING |
| `tests/carveout/forward.test.ts`             | `tenantId` + API key                     | Live Postgres + `seedTenantAndKey` fixture (real repositories) | Yes — test seeds real rows, hits live server                                            | ✓ FLOWING |
| `tests/private-contract/schema-lint.test.ts` | Introspected schema snapshot             | Live Postgres after `run-migrate.ts` applies baseline          | Yes — applies real migration, diffs against committed baseline                          | ✓ FLOWING |
| `0000_v1_baseline.sql`                       | Schema content                           | Generated from current `packages/db/src/schema/*.ts`           | Yes — 17 CREATE TABLE statements produced from drizzle-kit                              | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior                                                   | Command                                                                                                       | Result                                | Status |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| Carveout test suite passes against OSS-only server         | `pnpm test:carveout`                                                                                          | 7 tests / 3 files PASS (4.47s)        | ✓ PASS |
| Private-contract test suite passes (TS surface + SQL lint) | `pnpm test:private-contract`                                                                                  | 22 tests / 2 files PASS (3.73s)       | ✓ PASS |
| Full monorepo builds clean                                 | `pnpm build`                                                                                                  | 6/6 packages successful (cached)      | ✓ PASS |
| Primary CARVE-04 grep gate clean                           | `git grep -inE '(stripe\|billing\|usage_records\|plan: )' -- apps/api/src packages/db/src packages/queue/src` | 0 hits                                | ✓ PASS |
| `.env.example` clean                                       | `git grep -in 'stripe\|billing\|usage_records' -- .env.example`                                               | 0 hits                                | ✓ PASS |
| OpenAPI schemas + e2e fixtures clean                       | `grep -irEnl '(stripe\|billing\|usage_records\|plan: )' apps/api/src/schemas tests/e2e/fixtures`              | 0 hits                                | ✓ PASS |
| `docs/architecture.md` no billing mentions                 | `grep -inE 'stripe\|billing\|usage_records\|metering\|subscription' docs/architecture.md`                     | 0 hits                                | ✓ PASS |
| PR #1 is open + mergeable                                  | `gh pr view 1 --repo accidentally-awesome-labs/spatula --json mergeable,state`                                | `{state: OPEN, mergeable: MERGEABLE}` | ✓ PASS |
| PR #1 references policies in description                   | `gh pr view 1 ... -q .body \| grep -E 'no-migration-downgrade\|expand-contract\|upgrade.md'`                  | 4 matches                             | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s)      | Description                                                                                                                                      | Status      | Evidence                                                                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| CARVE-01    | 15-01, 15-02        | Section A billing files extracted to private `spatula-saas` repo with history preserved via `git filter-repo`                                    | ✓ SATISFIED | `6-1-filter-repo-evidence.md` records 19 files + 1 plan doc moved; OSS forward-deleted; private repo populated    |
| CARVE-02    | 15-03               | OSS code stripped of tier presets + Stripe coupling                                                                                              | ✓ SATISFIED | Grep gate green across `apps/api/src`, `packages/db/src`, `packages/queue/src`, `.env.example`, schemas, fixtures |
| CARVE-03    | 15-04               | All pre-Wave-6 migrations squashed into a single `0000_v1_baseline.sql` with billing tables absent                                               | ✓ SATISFIED | Single SQL file; 17 tables; 0 billing tables (verified by grep)                                                   |
| CARVE-04    | 15-03, 15-04, 15-06 | OSS Drizzle migrations under `packages/db/drizzle/` with `migrationsTable: '__drizzle_migrations_oss'`; documented in `docs/runbooks/upgrade.md` | ✓ SATISFIED | Namespaced in 3 sites (config + migrate.ts + run-migrate.ts); upgrade.md two-journal section present              |
| CARVE-05    | 15-05               | `tests/carveout/` verification suite passes                                                                                                      | ✓ SATISFIED | `pnpm test:carveout` 7/7 PASS                                                                                     |
| CARVE-06    | 15-05               | `tests/private-contract/` reverse-contract test exists; residual-risk acknowledged in `docs/private-contract.md`                                 | ✓ SATISFIED | 22/22 PASS; residual-risk register includes runtime drift + RLS/trigger + FK breakage rows                        |
| CARVE-07    | 15-06               | `docs/architecture.md` refreshed; no billing mentions remain; dependency diagram republished                                                     | ✓ SATISFIED | 0 billing keyword hits; carve-out section + private-contract.md cross-link present                                |
| CARVE-08    | 15-06               | No-migration-downgrade policy committed to `docs/runbooks/upgrade.md`; expand-contract documented as the only schema-change path post-v1         | ✓ SATISFIED | Both policies explicitly named in upgrade.md + referenced in PR #1 description                                    |

All 8 CARVE-\* requirements declared across plan frontmatters AND verified satisfied. No orphaned requirements (REQUIREMENTS.md maps CARVE-01..08 to Phase 15; all are claimed by one or more plans).

### Anti-Patterns Found

| File                                               | Line | Pattern                                                                                         | Severity | Impact                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical test fixtures + 1 pre-Phase-15 plan doc | n/a  | Stripe-prefix placeholder string (`sk_live_<32-char-test-placeholder>`) in 3 historical commits | ℹ️ Info  | Explicitly out-of-scope per CONTEXT.md D-04 + 15-06 SUMMARY follow-up note. These are documented test placeholders predating Phase 15. Not a verification gap.                                                                    |
| `tests/private-contract/baseline.schema.sql`       | n/a  | Plan 15-05 prescribed `baseline.schema.json` (drizzle-kit introspect); actual is `.sql`         | ℹ️ Info  | Plan 15-05's explicit Plan B fallback ("pg_dump --schema-only normalized") was adopted. SUMMARY-05 documents the choice + rationale (drizzle-kit version-path volatility). Test still asserts the contract; format is sanctioned. |

No blocker or warning anti-patterns. All TODO/FIXME/HACK/placeholder grep on modified files returned no functional stubs.

### Human Verification Required

None. All goal-derived truths verified programmatically:

- Test suites run live against real Postgres
- PR state confirmed via `gh pr view`
- Grep gates run on actual codebase
- Build verified across all 6 packages

Optional manual confirmations (not blocking):

- Manually click through PR #1 in GitHub UI to confirm merge-method dropdown defaults to "Create a merge commit" per D-08 (per 15-06 SUMMARY recommendation — this is a reviewer-time choice, not a code/doc gap).
- Confirm reviewers approve the long-term policy commitments (no-downgrade, expand-contract) before merge — this is product-judgement, not verification.

### Gaps Summary

**No gaps.** Phase 15 achieves its goal in full:

1. The OSS server is verifiably free of billing/Stripe/metering surface area at every primary scope (apps/api source, packages/db source, packages/queue source, .env.example, OpenAPI schemas, e2e fixtures, architecture doc).
2. The 12 pre-Wave-6 migrations are collapsed into a single `0000_v1_baseline.sql` (280 lines, 17 tables, 0 billing tables) tracked under the namespaced `__drizzle_migrations_oss` journal in all 3 required sites.
3. The contract that spatula-saas will consume is locked down by a passing two-suite reverse-contract test (TS surface + SQL schema lint), wired into PR CI for every PR.
4. Authoritative documentation lands: `docs/private-contract.md` (residual-risk register), `docs/runbooks/upgrade.md` (no-downgrade + expand-contract + dev-DB wipe-reseed + two-journal model), and a refreshed `docs/architecture.md`.
5. PR #1 is OPEN + MERGEABLE on `accidentally-awesome-labs/spatula` with merge-commit guidance and policy references.

Minor non-blocking observations (recorded above):

- Single-line discrepancy in baseline migration (280 vs 281 lines from prompt) — within rounding tolerance.
- `tests/private-contract/baseline.schema.sql` vs plan's prescribed `.json` — documented Plan-B fallback per 15-05 SUMMARY.
- Pre-Phase-15 historical Stripe placeholders in old test fixtures — explicitly out-of-scope per CONTEXT.md D-04.

---

_Verified: 2026-05-17T20:45:00Z_
_Verifier: Claude (gsd-verifier)_
