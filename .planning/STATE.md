---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Public Launch (Wave 6 / Phase 14)
status: executing
stopped_at: Completed 15-05-PLAN.md (carveout + private-contract tests + PR CI gates)
last_updated: "2026-05-17T18:59:04.931Z"
last_activity: 2026-05-17
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 6
  completed_plans: 5
  percent: 0
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-11)

**Core value:** Turn "I want X data from these sites" into a production-quality dataset with provenance.
**Current focus:** Phase 15 — carveout-migration-squash

## Current Position

Phase: 15 (carveout-migration-squash) — EXECUTING
Plan: 6 of 6
Status: Ready to execute
Last activity: 2026-05-17

Progress: [░░░░░░░░░░] 0% (0/8 v1.1 phases complete)

## Performance Metrics

**Velocity (v1.0 cumulative, carried over):**

- v1.0 shipped 2026-04-20 across Phases 1–13 (Waves 1–5 + 2026-04-20 cleanup)
- ~294 test files; 2,302 unit + 71 integration tests at close

**v1.1 (this milestone):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 15 | — | — | — |

*v1.1 metrics will populate as plans execute.*
| Phase 15 P01 | 70 min | 4 tasks | 3 files |
| Phase 15 P02 | 4min | 3 tasks | 19 files |
| Phase 15 P03 | 33min | 13 tasks | 35 files |
| Phase 15 P04 | 11min | 3 tasks | 10 files |
| Phase 15-carveout-migration-squash P05 | 13min | 4 tasks | 13 files |

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

Last session: 2026-05-17T18:58:57.674Z
Stopped at: Completed 15-05-PLAN.md (carveout + private-contract tests + PR CI gates)
Resume file: None
