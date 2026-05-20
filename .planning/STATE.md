---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Public Launch (Wave 6 / Phase 14)
status: verifying
stopped_at: Phase 17 context gathered
last_updated: "2026-05-20T01:27:31.497Z"
last_activity: 2026-05-19
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 11
  completed_plans: 11
  percent: 13
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-11)

**Core value:** Turn "I want X data from these sites" into a production-quality dataset with provenance.
**Current focus:** Phase 16 — api-contract-sdk-packages

## Current Position

Phase: 17
Plan: Not started
Status: Phase complete — ready for verification
Last activity: 2026-05-19

Progress: [█░░░░░░░░░] 13% (1/8 v1.1 phases complete)

## Performance Metrics

**Velocity (v1.0 cumulative, carried over):**

- v1.0 shipped 2026-04-20 across Phases 1–13 (Waves 1–5 + 2026-04-20 cleanup)
- ~294 test files; 2,302 unit + 71 integration tests at close

**v1.1 (this milestone):**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| 15    | —     | —     | —        |

_v1.1 metrics will populate as plans execute._
| Phase 15 P01 | 70 min | 4 tasks | 3 files |
| Phase 15 P02 | 4min | 3 tasks | 19 files |
| Phase 15 P03 | 33min | 13 tasks | 35 files |
| Phase 15 P04 | 11min | 3 tasks | 10 files |
| Phase 15-carveout-migration-squash P05 | 13min | 4 tasks | 13 files |
| Phase 15-carveout-migration-squash P06 | 25min | 6 tasks | 11 files |
| Phase 16 P1 | 75min | 4 tasks | 53 files |
| Phase 16 P2 | 19min | 3 tasks | 40 files |
| Phase 16-api-contract-sdk-packages P3 | 13min | 4 tasks | 15 files |
| Phase 16-api-contract-sdk-packages P4 | 21min | 3 tasks | 24 files |
| Phase 16-api-contract-sdk-packages P5 | 22min | 9 tasks | 27 files |

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions table. Recent decisions relevant to v1.1:

- Wave 6 carve-out + migration squash planned but unexecuted at v1.0 close — Phase 15 entry.
- Reference web UI is a non-goal for v1.1; ship web-UI **enablement** (SDK + OpenAPI + SSE + browser OIDC) only.
- Internal packages (`@spatula/core`, `db`, `queue`, `api`, `shared`) carry no TS-API compat guarantee; only `@spatula/cli`, `@spatula/client`, `@spatula/core-types` follow strict semver.
- Two separate Drizzle migration tracking tables (`__drizzle_migrations_oss`, `__drizzle_migrations_saas`) — no shared journal.
- [Phase 15]: Inventory deltas (4 files) absorb into Plan 15-03 Section B (no Plan 15-02 file-move impact)
- [Phase 15]: Typecheck baseline proxied via 'pnpm --filter X build' (tsc) — no typecheck script defined in packages
- [Phase 15]: Pre-existing CLI e2e flakes (workflow.test.ts + tier2/pipeline-errors.test.ts) deferred to Plan 15-05 fixture work
- [Phase 15]: Plan 15-02: Section A extracted (19 files, 13 commits) to spatula-saas via filter-repo on mirror clone; OSS history NOT rewritten; forward-deletion commit 20318a6 leaves OSS build intentionally broken (5 stale-import files routed to Plan 15-03)
- [Phase 15]: spatula-saas default branch is feat/wave-6-1-carveout (alphabetical alphabetical first-push artifact); benign — both refs at SHA c02d333; owner can flip to main in GitHub Settings
- [Phase 15]: Plan 15-03: 5 packages stripped of billing coupling (api, queue, core, db, shared); zero billing residues; OSS TS build GREEN
- [Phase 15]: Plan 15-03: GET /api/v1/auth/me added — returns {tenantId, scopes, subject, authenticated} top-level (no {data} envelope); CLI's getSubscription replaced by getAuthMe
- [Phase 15]: Plan 15-03: RATE_LIMIT_TIERS preset collapsed to DEFAULT_RATE_LIMIT (300 rpm, 10 concurrent); per-route customization deferred to Phase 16 config/rate-limits.yaml
- [Phase 15]: Plan 15-03: tenants schema reduced to 6 columns (id, name, config, quotas, storage_bytes_used, created_at); no plan/stripeCustomerId/idx_tenants_stripe_customer
- [Phase 15]: Plan 15-03: all 4 Plan 15-01 inventory deltas absorbed inline into natural Section B edits (no separate commits — auth.ts allowlist, api-keys.test scopes, remote-commands.test mock, db barrel)
- [Phase 15]: [Phase 15 Plan 04]: Rule-4 reformulation of D-05 pg_dump gate from 'diff must be empty' to 'diff matches frozen expected-billing-removal fixture'. Original D-05 (2026-05-12) predates Plan 15-03's billing strip — literal diff can never be empty by design. Reformulation preserves D-05's INTENT (detect accidental drift) via scripts/migration-equivalence-expected-diff.txt fixture.
- [Phase 15]: [Phase 15 Plan 04]: Rule-1 fix — content_store CHECK constraints (content_at_least_one, content_not_both) re-added to squashed baseline + meta/0000_snapshot.json. drizzle-kit generate omitted them because Drizzle TS only documents them in a // comment, not via check() API.
- [Phase 15]: [Phase 15 Plan 04]: Normalizer strips Postgres 14+ \restrict / \unrestrict random-token psql metacommands — required for any deterministic schema-diff tooling using pg_dump 14+.
- [Phase 15-carveout-migration-squash]: Plan B (pg_dump + Wave-4 normalizer) chosen over drizzle-kit introspect for SQL schema lint — pg_dump SQL is human-readable in PR diffs, reuses Plan 15-04's normalizer (one tool/one story), and avoids drizzle-kit JSON volatility across minor versions
- [Phase 15-carveout-migration-squash]: Node-builtin http.Server adapter (~30 lines) used in tests/carveout/fixtures/server.ts instead of @hono/node-server because pnpm did not hoist @hono/node-server to workspace root and adding it to root devDependencies would create an unnecessary root → app coupling
- [Phase 15-carveout-migration-squash]: Two separate CI jobs (test-carveout + test-private-contract) instead of one combined — gives clean per-contract PR check signal, parallel execution on GitHub runners, and DB isolation (separate spatula_test vs spatula_private_contract_test) so a forward-test seed leak cannot pollute the schema-lint diff
- [Phase 15-carveout-migration-squash]: Plan 15-06: Dropped dead 'stripe' dep from apps/api/package.json — Rule-1 fix; survived prior 5 plans because package.json wasn't in Section A filter-repo allowlist. Build + tests still green post-drop (purely subtractive). Final CARVE-04 grep gate now 0 hits across all 3 scopes.
- [Phase 15-carveout-migration-squash]: Plan 15-06: docs/private-contract.md authored in hybrid format per CONTEXT.md D-03 — surface enumeration per package + SQL FK reference + 8-row Residual Risk Register (runtime/RLS/trigger/column-default/ORM-major-drift/TS-type-shape/grants/journal-divergence) + change-procedure section + two-journal model. 153 lines.
- [Phase 15-carveout-migration-squash]: Plan 15-06: docs/runbooks/upgrade.md commits no-migration-downgrade (forward-only + pre-flight pg_dump) + expand-contract-only (with rename/type-change/split examples and additive-only exemptions) per ROADMAP success #5 + CARVE-08; PR description (Task 6) references both policies.
- [Phase 16]: Plan 16-1: ErrorCode enum staged in @spatula/shared (25 codes, 14 domains) for plan 16-2 to MOVE to @spatula/core-types per D-04 sequencing
- [Phase 16]: Plan 16-1: DLQ/API-key/Action 'not found' use ErrorCode.JOB_NOT_FOUND with details.resource discriminator — avoided enum growth mid-sweep for admin-only resources
- [Phase 16]: Plan 16-1: Hono c.req.routePath inside app.use('*', ...) returns middleware path (/*), not handler — rate-limit middleware walks matchedRoutes for per-route lookup
- [Phase 16]: Plan 16-1: rate-limit-config loader walks up parent dirs for config/rate-limits.yaml — robust to monorepo sub-package vitest cwd
- [Phase 16]: Plan 16-2: ErrorCode + JobConfig/FieldDef/Action/ExtractionResult schemas MOVED from @spatula/shared + @spatula/core to canonical home in @spatula/core-types; old paths preserved as re-export shims
- [Phase 16]: Plan 16-2: ESLint no-restricted-imports rule blocks value imports from @spatula/core-types monorepo-wide (allowTypeImports:true); per-file exemptions for canonical shim modules (shared/error-codes.ts + core/types/*.ts)
- [Phase 16]: Plan 16-2: @spatula/client codegen output (25 class-per-code error subclasses) COMMITTED to git; CI drift gate via 'pnpm gen:errors && git diff --exit-code' rather than build-time generation
- [Phase 16]: Plan 16-2: size-limit v12 requires sidecar esbuild config file (size-limit.esbuild.config.js) instead of inline 'esbuild:{...}' block — locks ESM+browser+es2022+minify+tree-shake measurement
- [Phase 16]: Plan 16-2: client.experimental Proxy returns undefined for JS-runtime well-known props (then/toJSON/constructor/symbols) so introspection doesn't explode; throws only on attempted use
- [Phase 16-api-contract-sdk-packages]: Plan 16-3: Validator pre-registers components.schemas with Ajv before per-response compile — fixes $ref resolution; without this, 38 of 38 response-schema compiles fail
- [Phase 16-api-contract-sdk-packages]: Plan 16-3: VersionProbe caches REJECTED promise on SpatulaVersionMismatchError (verdict sticky) but RESETS probePromise on transient transport error — two-tier cache semantics for D-12
- [Phase 16-api-contract-sdk-packages]: Plan 16-3: 404 from /.well-known/spatula-version treated as 'unknown server' — probe degrades gracefully so SDK works against non-Spatula servers in tests
- [Phase 16-api-contract-sdk-packages]: Plan 16-3: SDK_MAJOR_VERSION compiled as module-level const (currently 0); manual bump procedure documented in client.ts JSDoc, triggered alongside release-please major
- [Phase 16-api-contract-sdk-packages]: Plan 16-3: vitest config broadened to include src/**/*.test.ts so route tests can colocate with their sources (plan files specified colocated paths)
- [Phase 16-api-contract-sdk-packages]: Plan 16-4: Two-pass matrix driver — Pass 1 (spec-only example validation, deterministic) + Pass 2 (live 2xx best-effort) — catches both spec-side and runtime-side drift
- [Phase 16-api-contract-sdk-packages]: Plan 16-4: Contract harness uses Node-builtin http.Server adapter (carry-forward from Phase 15 tests/carveout/fixtures/server.ts) — avoids adding @hono/node-server to workspace root for a test-only concern
- [Phase 16-api-contract-sdk-packages]: Plan 16-4: Ajv2020 import via 'ajv/dist/2020.js' enforced in helpers/ajv-setup.ts (Pitfall #1 — default 'ajv' import silently uses draft-07 and mis-validates OpenAPI 3.1 nullable/prefixItems)
- [Phase 16-api-contract-sdk-packages]: Plan 16-4: ioredis added to root devDependencies (test-only) rather than re-exporting Redis from @spatula/db — keeps public-surface clean for a test-only concern
- [Phase 16-api-contract-sdk-packages]: Plan 16-4: Webhooks cookbook documents the v1 design target (1m, 5m, 30m, 2h, 8h → DLQ) with explicit 'current impl note' that webhook-worker.ts only ships first 3 delays at v1.0 — retry-schedule expansion is additive and does not change API contract
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: BLOCK-04 effective scope is @spatula (existing); fallback @spatulaai documented as 1-commit atomic rename procedure; final user clearance deferred to a logged-in npm session before publish
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: release-please uses node-workspace merge:false + linked-versions sdk-public:[core-types,client] — Pitfall #3 protection (no oscillating bumps); SDK packages bump together
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: release.yml uses GitHub OIDC trusted publishing (id-token:write at JOB level — Pitfall #4); no long-lived publish token; --provenance --access public per package; workflow upgrades npm to latest before publish (>= 11.5.1 required)
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: @spatula/cli uses tsup for dual ESM+CJS build with externalized playwright + workspace deps; preserves source shebang (no banner callback to avoid doubling)
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: SQLite v1.0 stays on better-sqlite3@12.10.0; Node 22 LTS bundled SQLite lacks FTS5 and node:sqlite is Experimental — feature parity gate fails per spec §3.2.3 across support matrix
- [Phase 16-api-contract-sdk-packages]: Plan 16-5: SDK integration tests branch on SPATULA_LIVE_LLM via it.skipIf(LIVE); default pnpm test excludes tests/integration/ so contributor-fork CI passes without OPENROUTER_API_KEY

### Pending Todos

None captured yet.

### Blockers/Concerns

All 9 pre-launch blockers are open as of 2026-05-12 (see PROJECT.md "Pre-launch blockers" list and REQUIREMENTS.md BLOCK-01..BLOCK-09). Each is mapped to the phase it gates in `.planning/ROADMAP.md`:

- ✅ BLOCK-01 → Phase 15 entry gate (private `spatula-saas` repo) — **CLEARED 2026-05-17**. Repo `accidentally-awesome-labs/spatula-saas` exists (PRIVATE, empty), reachable via SSH, `git-filter-repo` installed. Evidence: `docs/superpowers/plans/6-1-block01-evidence.md` (commit `2399516`).
- BLOCK-02 → Phase 18 / Phase 22 (legal entity or interim-name fallback)
- BLOCK-03 → Phase 20 entry gate (`spatula.dev` / `docs.spatula.dev` domains)
- BLOCK-04 → Phase 16 entry gate (npm `@spatula` org)
- BLOCK-05 → Phase 22 entry gate (GitHub namespace)
- BLOCK-06 → Phase 18 / Phase 22 (USPTO trademark search)
- BLOCK-07 → Phase 22 entry gate (beta invitee list)
- BLOCK-08 → Phase 20 entry gate (Cloudflare Pages + DNS)
- BLOCK-09 → Phase 18 / Phase 22 (historical-contributor enumeration + outreach)

### Pending Decisions

- Legal entity timing: form before public flip or accept interim-name LICENSE path.
- npm org / GitHub namespace / domain availability checks.
- SQLite driver decision in Phase 16 (`better-sqlite3` vs `node:sqlite`).

## Session Continuity

Last session: 2026-05-20T01:27:31.492Z
Stopped at: Phase 17 context gathered
Resume file: .planning/phases/17-browser-auth-sse-cors/17-CONTEXT.md
