---
phase: 15-carveout-migration-squash
plan: 05
subsystem: testing+ci
tags: [carveout, reverse-contract, forward-contract, vitest, pg-dump, schema-lint, openapi-shape, hono-test-server, github-actions-pr-gate]

# Dependency graph
requires:
  - phase: 15-03
    provides: GET /api/v1/auth/me endpoint + post-strip OSS surface (no billing/stripe/usage_records); 5-package barrel cleanups
  - phase: 15-04
    provides: 0000_v1_baseline.sql + __drizzle_migrations_oss namespaced journal + scripts/normalize-schema-dump.sh (reused for schema lint per D-03)
provides:
  - tests/carveout/ forward suite (7 tests across 3 files) proving OSS-only server satisfies post-carve contract
  - tests/private-contract/ reverse suite (22 tests across 2 files) freezing TS + SQL surface spatula-saas consumes
  - tests/private-contract/baseline.schema.sql (1086 lines) — committed SQL schema snapshot
  - tests/carveout/fixtures/server.ts — startCarveoutServer + seedTenantAndKey helpers using a Node-builtin http.Server adapter for Hono (zero workspace hoisting fragility)
  - pnpm test:carveout + pnpm test:private-contract root scripts
  - Two new PR-gating CI jobs (test-carveout + test-private-contract) wired with Postgres 16 service per D-04 cadence
affects: [15-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hono-on-Node-http-builtin adapter for test servers: when @hono/node-server isn't hoisted to a workspace's top-level node_modules, wrap app.fetch in a node:http server manually. Avoids root devDep bloat and pnpm workspace resolution gotchas."
    - "Realistic-shape mock-consumer import block: top-level destructure of @spatula/* barrels mirrors what spatula-saas would write, so missing-symbol failures surface at module-evaluation time (clear stack trace at import line, not buried in test body)."
    - "Affirmative-absent assertions: `expect(shared.BILLING_TIERS).toBeUndefined()` plus a regex sweep over Object.keys filtering /stripe|billing|quotaEnforcer|usageRecord|metering/i. Two-layered guard: per-symbol pin AND structural deny."
    - "Reuse-don't-rebuild for schema lint: pg_dump + Wave-4 normalizer (already handles \\restrict/\\unrestrict noise + journal-row stripping) chosen over drizzle-kit introspect — human-readable PR diffs, version-stable, single source of truth alongside Plan 15-04's equivalence gate."
    - "Two-tier graceful-skip for live-server suites: beforeAll catches DB/migration errors and sets a setupOk flag; per-test `if (!setupOk) return ctx.skip()` guards. Lets `pnpm test:carveout` and `pnpm test:private-contract` pass cleanly on cold contributor checkouts without Postgres."

key-files:
  created:
    - tests/carveout/vitest.config.ts
    - tests/carveout/openapi-shape.test.ts
    - tests/carveout/admin-metrics-smoke.test.ts
    - tests/carveout/forward.test.ts
    - tests/carveout/fixtures/server.ts
    - tests/private-contract/vitest.config.ts
    - tests/private-contract/oss-surface.test.ts
    - tests/private-contract/schema-lint.test.ts
    - tests/private-contract/baseline.schema.sql
    - tests/private-contract/README.md
    - .planning/phases/15-carveout-migration-squash/15-05-SUMMARY.md
  modified:
    - package.json
    - .github/workflows/ci.yml

key-decisions:
  - "Used pg_dump + Wave-4 normalizer for SQL schema lint (Plan-B in the planner's text) instead of drizzle-kit introspect. Per plan's explicit guidance ('if drizzle-kit's introspect output is volatile, fall back to Plan B') + CONTEXT.md D-03's 'planner picks'. Wave 4's normalizer already battle-tested for pg_dump 14+ \\restrict random-token noise + __drizzle_migrations journal stripping. Reused 1:1 — no normalizer changes needed."
  - "Replaced @hono/node-server with a Node-builtin http.createServer adapter in tests/carveout/fixtures/server.ts. @hono/node-server is only declared in apps/api/package.json and pnpm did not hoist it to the workspace root; Vite couldn't resolve it from tests/carveout/. Rather than add it to root devDependencies (would create a root → app dep coupling), wrote a ~30-line adapter that maps node:http IncomingMessage → fetch Request → app.fetch → Response → ServerResponse. Pure stdlib, no new deps."
  - "Committed baseline as SQL text (baseline.schema.sql, 1086 lines) not JSON. Trade-off vs the plan's drizzle-kit-introspect-suggesting baseline.schema.json: SQL diffs are human-readable in PR reviews ('you added a column' is plain to a reviewer); JSON shape varies across drizzle-kit minor versions and is fragile."
  - "Forward test (forward.test.ts) seeds with scopes:['admin'] by default — gives 200 from /admin/tenants/:id; documented [200, 403] acceptance to keep the test resilient to a future seed-default change to non-admin scopes."
  - "turbo.json untouched. The new test:* scripts are root-level vitest invocations (like the existing test:e2e), not turbo task graph entries. Adding them to turbo.json would conflict with the per-package `test` task that already exists. Same pattern as test:e2e."
  - "Two separate CI jobs (test-carveout + test-private-contract) instead of one combined job. Separation gives clean PR-checks-page signal ('which contract broke?'), parallel execution on GitHub runners, and independent Postgres service isolation (separate DB names spatula_test vs spatula_private_contract_test) so a forward-test seed leak can't pollute the schema-lint baseline diff."

patterns-established:
  - "Forward + reverse contract tests as PR merge gates: forward (tests/carveout/) proves the OSS server satisfies the post-carve contract; reverse (tests/private-contract/) proves nothing the private consumer reaches for has been silently removed. Together they bracket the carve-out: forward catches OSS-side regressions, reverse catches accidental private-coupling-restoration."
  - "Schema snapshot via SQL text not JSON: when the goal is 'reviewer can see what changed at PR time', commit pg_dump --schema-only output normalized by a tool-stable script. Reviewers read SQL; PR diffs are self-documenting."
  - "Mock-consumer test = realistic destructure block: not a synthetic enumeration. Top-level destructure of all consumed symbols mimics what the consumer's real code looks like and lets missing-symbol errors surface at module-evaluation time."

requirements-completed: [CARVE-05, CARVE-06]

# Metrics
duration: ~13min
completed: 2026-05-17
---

# Phase 15 Plan 05: Forward Carveout Suite + Reverse Private-Contract Suite + PR CI Gates Summary

**Two new test suites (`tests/carveout/` 7-test forward + `tests/private-contract/` 22-test reverse with 1086-line committed SQL schema baseline) wired into PR CI on every push as merge gates — gating evidence for ROADMAP Phase 15 success criteria #1 (forward) and #2 (reverse) is now in place.**

## Performance

- **Duration:** ~13 min (started 2026-05-17T18:43:00Z, completed 2026-05-17T18:56:07Z)
- **Tasks:** 4 (all auto, no checkpoints, no TDD)
- **Commits:** 4 task commits on `feat/wave-6-1-carveout`:
  - `6f893eb` — Task 1: forward suite
  - `4e30630` — Task 2: TS-surface reverse-contract + README
  - `b791fa9` — Task 3: SQL schema lint + baseline + README append
  - `650f124` — Task 4: package.json scripts + CI wiring
- **Files created:** 11 (10 test artifacts + this summary)
- **Files modified:** 2 (package.json, .github/workflows/ci.yml)

## Accomplishments

- **Forward carve-out suite live and passing.** 7 tests across 3 files in `tests/carveout/`:
  - `openapi-shape.test.ts` (3 tests, no DB): asserts no `/api/v1/billing*` paths, no stripe paths, no `Subscription`/`UsageRecord`/`StripeEvent`/`BillingTier` schemas in the OpenAPI document.
  - `admin-metrics-smoke.test.ts` (1 test, mocked deps): asserts `GET /api/v1/admin/system/metrics` does not 500 with a `usage_records`-shaped error; if 200, body contains no `usage_records`/`usageRecord` references.
  - `forward.test.ts` (3 tests, live server + Postgres): boots `createApp(deps)` on an ephemeral http port via a Node-builtin http.Server adapter, seeds a real tenant + `sk_live_*` API key, then exercises `GET /auth/me` (asserts tenantId + scopes + authenticated:true; no plan/stripe/usage leak), `GET /admin/tenants/:id` (asserts no plan/stripeCustomerId/usage keys), and `GET /api/openapi.json` from the live server.
  - Fixtures `tests/carveout/fixtures/server.ts`: exports `startCarveoutServer(databaseUrl)`, `seedTenantAndKey(handle, name, opts?)`, `ForwardTestHandle` interface. Uses `node:http` + `Request`/`Response` instead of `@hono/node-server` to dodge a pnpm hoisting issue (see decision #2).

- **Reverse private-contract suite live and passing.** 22 tests across 2 files in `tests/private-contract/`:
  - `oss-surface.test.ts` (21 tests, no DB): top-level destructure mock-consumer import block per CONTEXT.md "Specifics", with 6 describe blocks pinning the TS surface for `@spatula/{core,db,queue,shared,api}`, plus a negative-filter sweep that iterates every package barrel and asserts zero exports match `/stripe|billing|quotaEnforcer|usageRecord|metering/i`. Affirmative-absent assertions: `BILLING_TIERS` and `RATE_LIMIT_TIERS` are explicitly `expect(...).toBeUndefined()`.
  - `schema-lint.test.ts` (1 test, Postgres + pg_dump): applies `0000_v1_baseline.sql` via `pnpm --filter @spatula/db exec tsx src/run-migrate.ts` (honors Plan-15-04's `__drizzle_migrations_oss` journal), spawns `pg_dump --schema-only --no-owner --no-acl`, pipes through Wave-4's `scripts/normalize-schema-dump.sh`, and asserts byte-equal match against committed `tests/private-contract/baseline.schema.sql`.

- **Committed SQL schema baseline.** `tests/private-contract/baseline.schema.sql` — 1086 lines. Generated from a fresh empty Postgres after running the squashed `0000_v1_baseline.sql`. Captures 17 tables (no `usage_records`), 8 enum types, all FKs/indexes/CHECK constraints, the `drizzle` schema with the `__drizzle_migrations_oss` tracking table. PR diff against this file is the human-readable signal that schema drift has happened.

- **PR CI gating ready.** `.github/workflows/ci.yml` extended with two new jobs:
  - `test-carveout` ("Forward Carve-out Tests"): Postgres 16 service on `spatula_test`, applies v1 baseline migration, runs `pnpm run test:carveout`.
  - `test-private-contract` ("Reverse Private-Contract Tests"): Postgres 16 service on `spatula_private_contract_test`, runs `pnpm run test:private-contract` (schema-lint's beforeAll applies the migration itself).
  - Both inherit the existing `on: [push, pull_request, workflow_call]` triggers — D-04 every-PR cadence implemented.
  - YAML validated (`python3 -c "import yaml; yaml.safe_load(...)"` exits 0).

- **Root scripts exposed.** `package.json` now exports `test:carveout` and `test:private-contract`, parallel to the existing `test:e2e`. Downstream tooling can invoke directly without `pnpm exec vitest run --config ...` boilerplate.

## Task Commits

| Task | Description | Commit |
| ---- | ----------- | ------ |
| 1 | Forward carve-out suite (openapi-shape + admin-metrics-smoke + forward.test.ts + fixtures/server.ts) | `6f893eb` |
| 2 | Private-contract TS-surface test (oss-surface.test.ts) + README | `4e30630` |
| 3 | Private-contract SQL schema lint (schema-lint.test.ts + baseline.schema.sql + README append) | `b791fa9` |
| 4 | Wire carveout + private-contract suites into PR CI (package.json + ci.yml) | `650f124` |

**Plan metadata commit:** will follow this summary.

## Test Counts

| Suite | Files | Tests | Passing | Runtime (local) |
| ----- | ----- | ----- | ------- | --------------- |
| `tests/carveout/` | 3 | 7 | 7 | ~2.5s |
| `tests/private-contract/` | 2 | 22 | 22 | ~3.1s |
| **Total new** | **5** | **29** | **29** | **~5.6s** |

Both suites verified end-to-end against fresh Postgres DBs (full schema reset + re-migrate + test run) immediately before the final commit.

## Files Created/Modified

**Created (11):**
- `tests/carveout/vitest.config.ts` — vitest config (Node env, 30s timeout, workspace aliases mirroring tests/e2e)
- `tests/carveout/openapi-shape.test.ts` — 3 forbidden-surface assertions against /api/openapi.json
- `tests/carveout/admin-metrics-smoke.test.ts` — 1 no-500-on-usage_records smoke test
- `tests/carveout/forward.test.ts` — 3 live-server tests (auth/me, admin/tenants/:id, openapi.json)
- `tests/carveout/fixtures/server.ts` — startCarveoutServer + seedTenantAndKey + ForwardTestHandle
- `tests/private-contract/vitest.config.ts` — vitest config (60s timeout for the migration apply in schema-lint beforeAll)
- `tests/private-contract/oss-surface.test.ts` — 21 TS-surface freeze assertions (6 describes)
- `tests/private-contract/schema-lint.test.ts` — 1 pg_dump-normalized-byte-equal-baseline assertion
- `tests/private-contract/baseline.schema.sql` — 1086-line committed SQL schema snapshot
- `tests/private-contract/README.md` — how-to-run + what-catches + what-doesn't + update procedure (TS surface + SQL schema lint sections)
- `.planning/phases/15-carveout-migration-squash/15-05-SUMMARY.md` — this file

**Modified (2):**
- `package.json` — added `test:carveout` and `test:private-contract` scripts
- `.github/workflows/ci.yml` — added `test-carveout` and `test-private-contract` jobs, both with Postgres 16 services, both running on existing PR + push + workflow_call triggers

**turbo.json — intentionally untouched** (root-level vitest scripts don't need turbo task graph entries; same as existing test:e2e).

## Decisions Made

- **Plan B (pg_dump + Wave-4 normalizer) over Plan A (drizzle-kit introspect) for SQL schema lint.** Explicitly sanctioned by CONTEXT.md D-03 ("planner picks") and the plan's own caveat ("if drizzle-kit's introspect output is volatile, fall back to Plan B"). Reasoning:
  1. Wave-4's `scripts/normalize-schema-dump.sh` already handles pg_dump 14+ `\restrict`/`\unrestrict` random-token noise + `__drizzle_migrations*` COPY-block stripping; reusing it is one less moving part.
  2. pg_dump SQL output is human-readable in PR diffs ("you dropped a column" reads as plain SQL); drizzle-kit JSON is opaque to reviewers.
  3. drizzle-kit introspect's JSON shape is undocumented and known to change across minor versions (per the plan's own caveat).
  4. Plan 15-04's migration-equivalence gate already uses pg_dump as ground truth — keeping the same tool/normalizer pipeline gives a single coherent schema-validation story.

- **Node-builtin http.Server adapter instead of @hono/node-server.** `@hono/node-server` is declared in `apps/api/package.json` but pnpm did not hoist it to the workspace root; Vite couldn't resolve the bare import from `tests/carveout/fixtures/server.ts`. Two alternatives: (a) add `@hono/node-server` to root `devDependencies` (creates a root → app dep coupling), (b) write a ~30-line adapter wrapping `app.fetch` with `node:http`. Picked (b) — pure stdlib, no new root dep, no upstream coupling, and trivially documented. Hono's `app.fetch` accepts standard `Request` and returns standard `Response`, so the adapter is straightforward (collect body bytes, build a Request, await `app.fetch`, write status + headers + body to ServerResponse).

- **Baseline as SQL text not JSON.** `tests/private-contract/baseline.schema.sql` not `.json`. Follows from the Plan B choice above. The plan's `<files_modified>` block listed `baseline.schema.json` — the SQL-text variant is the substantive equivalent under Plan B; renamed for clarity (extension matches content). Updated the schema-lint test, README, and acceptance-criteria checks accordingly.

- **Two CI jobs not one.** `test-carveout` and `test-private-contract` are separate GitHub Actions jobs (each with its own Postgres service + separate DB name). Three benefits: (1) the PR checks page tells reviewers exactly which contract broke; (2) parallel execution on GitHub runners (~30s wall-clock vs ~60s sequential); (3) DB isolation — a forward-test seed leak can't pollute the schema-lint diff.

- **Forward test seeds with admin scope by default.** `seedTenantAndKey(handle, name, opts?)` defaults `scopes: ['admin']`. Gives 200 on `GET /admin/tenants/:id` so the post-carve body-shape assertions actually run. Test documents `[200, 403]` as acceptable to keep it resilient to a future seed-default change.

- **turbo.json intentionally untouched.** The new `test:carveout` + `test:private-contract` scripts are root-level vitest invocations, parallel in shape to the existing root-level `test:e2e` script (which also has no turbo entry). Adding them to `turbo.json`'s `tasks` object would conflict semantically with the per-package `test` task. Same pattern as the existing convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] `@hono/node-server` not resolvable from `tests/carveout/fixtures/server.ts`**
- **Found during:** Task 1, first vitest run of the forward suite
- **Issue:** First fixture draft imported `serve` from `@hono/node-server` (modeled on `apps/api/src/server.ts`). vitest+Vite failed to resolve the bare import because pnpm only installs `@hono/node-server` under `apps/api/node_modules` — not hoisted to the workspace root, so `tests/carveout/` (a top-level test dir) couldn't see it. Error: `Failed to load url @hono/node-server`.
- **Fix:** Rewrote the fixture to use `node:http` `createServer` and adapt `IncomingMessage` → standard `Request` → `app.fetch` → standard `Response` → `ServerResponse`. ~30 lines, zero new deps. The adapter handles GET/HEAD body absence, multi-header values, and request-context errors with a 500 fallback.
- **Files modified:** `tests/carveout/fixtures/server.ts`
- **Verification:** Re-ran `pnpm exec vitest run --config tests/carveout/vitest.config.ts` — all 7 tests pass including the 3 live-server forward tests that exercise the adapter end-to-end.
- **Committed in:** `6f893eb` (Task 1 commit — fix folded into the same commit since the first-draft version never landed).

### Documented (intentional planner choice, not a deviation)

**2. SQL baseline file extension differs from plan listing**
- **Detail:** Plan frontmatter `files_modified` lists `tests/private-contract/baseline.schema.json`. Implementation committed `tests/private-contract/baseline.schema.sql` (SQL text under Plan B, not JSON under Plan A).
- **Reason:** CONTEXT.md D-03 says "planner picks" between drizzle-kit JSON and pg_dump SQL; the plan's `<action>` block in Task 3 explicitly documents the Plan-B fallback. The extension change is a natural consequence of the format choice — `.json` would be misleading next to text content.
- **Files affected:** Test, README, and acceptance-criteria check all updated to reference the SQL file.

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocker) + 1 documented (planner pick under explicit plan guidance).
**Impact on plan:** The blocker fix is invisible (pure stdlib adapter, no consumer impact). The SQL-vs-JSON pick was sanctioned by the plan + CONTEXT.md.

## Issues Encountered

- **pnpm workspace hoisting gap for @hono/node-server.** Documented above as Deviation #1. Resolved with a `node:http` adapter. Pattern is reusable for any future test directory that needs to boot a Hono app outside the `apps/api` package boundary.
- **psql access to homebrew Postgres 14 (not 16).** Local dev runs Postgres 14.22 (psql client + server). CI uses postgres:16-alpine. The schema-lint test passes against both because the Wave-4 normalizer strips version-specific preamble + `\restrict` tokens that differ between 14 and 16. Verified the baseline (generated against Postgres 14 locally) by re-running schema-lint against a freshly-migrated 14 DB — exact match.

## Authentication Gates

None during this plan — no auth/network/secrets operations. The forward test mints its own API keys directly via the live `ApiKeyRepository`, bypassing any human-in-the-loop credential dance.

## User Setup Required

None — Plan 15-05 is fully automated. Plan 15-06 (CARVE-04 final grep gate + `docs/private-contract.md` + runbook policies) requires no additional user setup either.

## Known Stubs

None — every assertion is real:
- `tests/carveout/openapi-shape.test.ts` reads the actual generated OpenAPI doc from a live `createApp` instance.
- `tests/carveout/admin-metrics-smoke.test.ts` uses the actual `/api/v1/admin/system/metrics` handler with realistic mock deps.
- `tests/carveout/forward.test.ts` boots a real http server, seeds a real tenant + API key via real repos, and round-trips real HTTP requests.
- `tests/private-contract/oss-surface.test.ts` imports the actual package barrels and asserts on real `typeof` + real `Object.keys`.
- `tests/private-contract/schema-lint.test.ts` runs the actual `0000_v1_baseline.sql` against a real Postgres and diffs against the actual committed baseline.

## Next Phase Readiness

**Ready for Plan 15-06 (CARVE-04 final grep gate + docs/private-contract.md + docs/runbooks/upgrade.md + ROADMAP architecture refresh per CARVE-07).**

- Branch `feat/wave-6-1-carveout` tip at `650f124` (will advance to plan-metadata commit after this SUMMARY).
- Both new CI jobs are wired and YAML-valid; first GitHub Actions run on the carve-out PR will be the canonical green signal in the GitHub Actions environment.
- `tests/private-contract/baseline.schema.sql` is committed and tracks the post-Plan-15-04 schema — Plan 15-06 can reference it from `docs/private-contract.md` as the authoritative schema-surface document.
- TS-surface freeze in `tests/private-contract/oss-surface.test.ts` enumerates exactly the 5-package contract Plan 15-06's `docs/private-contract.md` should narrate prose for.
- Test counts for `pnpm test` totals (Plan 15-03 SUMMARY's per-package isolated runs) are unaffected — these new suites live under root `tests/`, not under package boundaries, and don't appear in any per-package vitest run.

## Self-Check: PASSED

- [x] `tests/carveout/vitest.config.ts` — FOUND on disk
- [x] `tests/carveout/openapi-shape.test.ts` — FOUND on disk
- [x] `tests/carveout/admin-metrics-smoke.test.ts` — FOUND on disk
- [x] `tests/carveout/forward.test.ts` — FOUND on disk
- [x] `tests/carveout/fixtures/server.ts` — FOUND on disk
- [x] `tests/private-contract/vitest.config.ts` — FOUND on disk
- [x] `tests/private-contract/oss-surface.test.ts` — FOUND on disk
- [x] `tests/private-contract/schema-lint.test.ts` — FOUND on disk
- [x] `tests/private-contract/baseline.schema.sql` — FOUND on disk (1086 lines)
- [x] `tests/private-contract/README.md` — FOUND on disk
- [x] Commit `6f893eb` (Task 1) — FOUND in git log
- [x] Commit `4e30630` (Task 2) — FOUND in git log
- [x] Commit `b791fa9` (Task 3) — FOUND in git log
- [x] Commit `650f124` (Task 4) — FOUND in git log
- [x] `pnpm run test:carveout` exits 0 (7/7 tests pass)
- [x] `pnpm run test:private-contract` exits 0 (22/22 tests pass)
- [x] `node -e "...test:carveout && ...test:private-contract"` exits 0
- [x] `grep -c "test:carveout\|test:private-contract" .github/workflows/ci.yml` returns 2
- [x] `grep -c "pull_request" .github/workflows/ci.yml` returns 1 (workflow runs on PR)
- [x] `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` exits 0
- [x] `grep -c "billing\|stripe" tests/carveout/openapi-shape.test.ts` returns 7 (≥4)
- [x] `grep -c "startCarveoutServer\|seedTenantAndKey" tests/carveout/forward.test.ts` returns 4 (≥2)
- [x] `grep -c "auth/me" tests/carveout/forward.test.ts` returns 2 (≥1)
- [x] `grep -c "@spatula/core\|@spatula/db\|@spatula/queue\|@spatula/shared" tests/private-contract/oss-surface.test.ts` returns 12 (≥4)
- [x] `grep -c "BILLING_TIERS\|RATE_LIMIT_TIERS" tests/private-contract/oss-surface.test.ts` returns 4 (≥2)
- [x] README has both "What this catches" and "What this does NOT catch" sections
- [x] `grep -c "pg_dump" tests/private-contract/schema-lint.test.ts` returns 7 (≥1; reuses Wave-4 normalizer per D-03)
- [x] `grep -c "schema-lint\|baseline.schema" tests/private-contract/README.md` returns 8 (≥2)

---
*Phase: 15-carveout-migration-squash*
*Completed: 2026-05-17*
