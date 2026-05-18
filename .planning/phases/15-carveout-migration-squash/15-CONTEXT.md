# Phase 15: Carve-out & Migration Squash - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

<domain>
## Phase Boundary

OSS-only server has zero Stripe/billing/metering surface area. Pre-Wave-6 migrations (0000–0011) collapse into a single `000_v1_baseline.sql`. The TS + SQL contract the private `spatula-saas` repo consumes is locked down with a reverse-contract test that runs on every PR. Residual non-TS risks (runtime drift, RLS/triggers, FK semantics) acknowledged in `docs/private-contract.md`.

In scope: extraction via `git filter-repo` into private repo, in-place strip of billing coupling, migration squash with namespaced journal, new `GET /api/v1/auth/me` endpoint, two new test suites (`tests/carveout/` forward + `tests/private-contract/` reverse), runbook policies.

Out of scope: standing up `spatula-saas` private repo itself (BLOCK-01 prereq), trademark/legal docset (Phase 18), domain/DNS work (Phase 20).

</domain>

<decisions>
## Implementation Decisions

### Plan Source-of-Truth

- **D-01:** **Hybrid** — pre-drafted plan at `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md` (27 tasks, 2429 lines) is the substrate. Planner reads it as input, then writes delta tasks for items the v1.1 ROADMAP added after 2026-04-20: (a) reverse-contract CI cadence wiring, (b) SQL schema lint addition to private-contract test, (c) `pg_dump --schema-only` equivalence gate in PR CI, (d) `docs/runbooks/upgrade.md` policy commits (no-migration-downgrade + expand-contract-only), (e) BLOCK-01 pre-phase gate verification step.
- **D-02:** Do **NOT** use express PRD path (`/gsd:plan-phase 15 --prd <path>`). The pre-drafted plan precedes v1.1 ROADMAP success criteria; verbatim consumption would miss reconciliation deltas.

### Reverse-Contract Test (CARVE-06)

- **D-03:** **Depth = TS surface + SQL schema lint + doc residuals.**
  - Keep pre-drafted TS-surface test (`tests/private-contract/oss-surface.test.ts`) — mocked private consumer imports `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`, `@spatula/api`; build fails on silent symbol removal.
  - **Add SQL schema lint:** snapshot OSS schema (e.g., via `drizzle-kit introspect` or `pg_dump --schema-only` output normalized) against a saved `tests/private-contract/baseline.sql` (or `baseline.json`). PR fails on drift in tables, columns, FKs, RLS policies, triggers consumed by the private repo.
  - **Doc residuals only:** runtime-behavior drift (function semantics changing under stable signature) and behavioral guarantees outside the TS+SQL envelope go into `docs/private-contract.md` residual-risk register. No runtime smoke test in OSS — that's spatula-saas's integration suite to own.
- **D-04:** **CI cadence = every PR.** Reverse-contract job runs on every PR push. Adds ~30s–2min. Matches ROADMAP success #2 wording ("breaks the build when a consumed export is silently removed") — implies PR-time, not nightly.

### Migration Squash Equivalence

- **D-05:** **Proof method = `pg_dump --schema-only` diff in PR CI.** Single canonical gate:
  - Spin two ephemeral Postgres instances in CI.
  - DB-A: apply `0000_previous_nova.sql` through `0011_young_boomer.sql` in order.
  - DB-B: apply `000_v1_baseline.sql` alone.
  - `pg_dump --schema-only` both. Normalize output (strip `__drizzle_migrations*` rows, sort objects, strip timestamps/comments). `diff` must be empty.
  - Gate runs on the carve-out PR; can be removed post-merge or kept as a permanent guard against silent baseline drift (planner decides).
- **D-06:** Drizzle introspect snapshot diff is **not** the canonical proof (trusts drizzle internals); pg_dump output is the authoritative ground truth. Drizzle snapshot can be a secondary sanity check if the planner wants belt-and-suspenders, but pg_dump diff is the merge gate.

### PR Shape

- **D-07:** **Single PR, organized commits.** One `feat/wave-6-1-carveout` branch carrying 27 per-task commits grouped by stage:
  1. `feat(carveout): take pre-cut snapshot + re-verify inventory`
     2–N. `feat(carveout): filter-repo move {file} → spatula-saas` (per file group)
     N+1–M. `feat(carveout): strip billing coupling from {area}` (per package)
     M+1–P. `feat(carveout): squash migrations to v1 baseline`
     P+1–Q. `feat(carveout): add tests/carveout + tests/private-contract`
     Q+1–R. `feat(carveout): commit runbook policies + private-contract.md`
- **D-08:** **Merge strategy = merge-commit** (not squash). Preserves per-task history for `git bisect` if a future regression points at the carve-out window. Squash-merge is **rejected** — would nuke 27 commits of context for a one-time payoff.
- **D-09:** Stacked PRs **rejected** — partial-merge between stages leaves OSS server in a broken state (e.g., billing routes mounted but `quotaEnforcer` deleted), which would block any other PR landing during the carve-out window.

### Claude's Discretion (planner decides)

- `docs/private-contract.md` format — pick one of: ADR-style decision records per residual risk, short risk register table (risk | likelihood | mitigation | owner), or surface contract doc enumerating consumed symbols. Recommendation: hybrid (surface contract doc with a residual-risk table appended). Planner choose during plan-phase.
- `docs/runbooks/` directory structure — first runbook is `upgrade.md`. Future runbooks (`backup-restore.md` etc.) are Phase 19 scope; layout the dir but don't pre-stub.
- SQL schema lint implementation — `drizzle-kit introspect` JSON diff OR normalized `pg_dump` snapshot. Either is acceptable; planner picks based on tooling ergonomics.
- Per-stage commit count granularity within "Single PR, organized commits" — 27 is the plan's target; planner may merge trivial commits if it improves reviewability.
- BLOCK-01 verification step format — Task 1 in plan should fail-fast if `accidentally-awesome-labs/spatula-saas` is not a writable remote (curl + auth check). Planner decides exact form.

### Folded Todos

None — `gsd-tools todo match-phase 15` returned zero matches.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Pre-drafted plan (substrate for hybrid approach)

- `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md` — full 27-task draft; file inventory (A: move, B: edit, C: create, D: delete); product decisions locked (`usage.ts` stays OSS; new `/auth/me` endpoint); per-task command lines for `git filter-repo`, schema regen, test scaffolding.

### Roadmap + requirements

- `.planning/ROADMAP.md` §"Phase 15: Carve-out & Migration Squash" — goal, 5 success criteria, BLOCK-01 pre-phase gate, depends-on chain.
- `.planning/REQUIREMENTS.md` CARVE-01..CARVE-08 — eight acceptance items planner must check off.
- `.planning/PROJECT.md` — vision, principles, naming, internal-vs-public-package compat policy.
- `.planning/STATE.md` — current pre-launch blocker statuses; pending-decisions register.

### Codebase maps

- `.planning/codebase/CONCERNS.md` §"Billing & SaaS Coupling (Wave 5-6 Carve-out)" — re-verified file inventory as of 2026-05-06 (commit `42761d5` baseline).
- `.planning/codebase/ARCHITECTURE.md` — current module boundaries (planner needs to update post-carve-out per CARVE-07).
- `.planning/codebase/STRUCTURE.md` — package layout to confirm `apps/api/src/billing/` becomes empty/removed.
- `.planning/codebase/CONVENTIONS.md` — test placement, commit message style, Drizzle migration conventions.
- `.planning/codebase/TESTING.md` — existing test patterns (`tests/e2e/`, `vitest.config.ts`) — new `tests/carveout/` and `tests/private-contract/` follow same shape.

### Architecture docs to update post-carve

- `docs/architecture.md` — refresh dependency diagram, drop all billing mentions (CARVE-07 requirement).

### Docs to be created in this phase

- `docs/private-contract.md` — authoritative 5-package surface contract + residual-risk register (TS-only test coverage; SQL FK / runtime drift / RLS treated as documented residuals).
- `docs/runbooks/upgrade.md` — no-migration-downgrade policy, expand-contract-only schema-change rule, pre-Wave-6 dev DB wipe-and-reseed instructions.
- `tests/private-contract/README.md` — how-to-run + what the test guarantees.

### Migration history (sources for squash)

- `packages/db/drizzle/0000_previous_nova.sql` through `0011_young_boomer.sql` — twelve migrations to collapse into `000_v1_baseline.sql`.
- `packages/db/drizzle/meta/` — existing Drizzle snapshots, all regenerated post-squash.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **Vitest config patterns** (`apps/api/vitest.config.ts`, `packages/*/vitest.config.ts`) — new `tests/carveout/vitest.config.ts` + `tests/private-contract/vitest.config.ts` copy the established shape.
- **`apps/api/tests/unit/`** — existing per-route unit tests are the template for the new `apps/api/tests/unit/routes/auth.test.ts` covering `GET /api/v1/auth/me`.
- **Drizzle migration generation** (`pnpm --filter @spatula/db build` + `drizzle-kit generate`) — already wired; the squash uses the same toolchain.
- **CI workflow files** under `.github/workflows/` — planner adds the reverse-contract job + pg_dump-diff job into existing test pipeline rather than standing up a new one.

### Established Patterns

- **ESM-only TypeScript** (`"type": "module"`) — both new test suites import via `.js` extensions on relative paths.
- **Turborepo task graph** — `pnpm test`, `pnpm build`, `pnpm db:migrate` already topo-aware; new suites plug into `turbo test` filter.
- **Per-tenant rate limiting** without billing tier — `DEFAULT_RATE_LIMIT` already exported; carve-out collapses `RATE_LIMIT_TIERS` → `DEFAULT_RATE_LIMIT` only.
- **Two-stage migration journal** decision (`__drizzle_migrations_oss` vs `__drizzle_migrations_saas`) is already encoded in pre-drafted plan; planner respects.

### Integration Points

- **`apps/api/src/app.ts`** — billing/stripe-webhook route mounts removed, plan-loading middleware removed; new `auth.ts` route mounted at `/api/v1/auth/me`.
- **`apps/api/src/types.ts`** — `AppDeps` loses `quotaEnforcer`, `usageRecordRepo`, `stripeClient`; `AppEnv` loses `rateLimitTier`. Every downstream Hono handler that pulls these via `c.get()` is updated.
- **`packages/queue/src/worker-deps.ts`** — `quotaEnforcer` field removed; `crawl-worker` and `export-orchestrator` lose their `deps.quotaEnforcer.*` call sites.
- **`apps/cli/src/api/client.ts`** + **`remote.ts`** — `getSubscription()` deleted, `getAuthMe()` added, `remote add` probe rewired.
- **`packages/db/src/schema/tenants.ts`** — `plan`, `stripeCustomerId` columns dropped; `idx_tenants_stripe_customer` dropped; `rateLimitTier` removed from `quotas` JSONB default.

### Constraints

- **History rewrite on OSS prohibited** (per spec §3.1.4) — billing files are _deleted_ from OSS main forward; history is preserved via `git filter-repo` into the _private_ repo, not by rewriting OSS.
- **No backward compat shim for `/billing/subscription`** — CLI + server ship together in v1.0 release window; self-hosters do an atomic upgrade. Already a locked decision in pre-drafted plan.
- **BLOCK-01 is a hard gate.** Plan Task 1 must fail-fast if `accidentally-awesome-labs/spatula-saas` is not reachable as a writable remote with the CI automation account's credentials.

</code_context>

<specifics>
## Specific Ideas

- Reverse-contract test ergonomics: the mocked private consumer file should look like a _realistic_ `spatula-saas` import block — not a synthetic enumeration — so silent removals fail with messages a saas-side developer would immediately recognize.
- `pg_dump --schema-only` normalizer: strip rows from `__drizzle_migrations*` tables, sort `CREATE` statements lexically, drop `-- Dumped from database version X.Y` headers, drop comment lines, strip timestamps. Reuse a small `scripts/normalize-schema-dump.sh` or inline in CI step — planner picks.
- Per-stage commit messages should use a stable `feat(carveout):` prefix so the post-merge changelog can filter the wave-6-1 footprint cleanly.

</specifics>

<deferred>
## Deferred Ideas

- **Post-carve OSS-only smoke deploy** (boot OSS server on clean machine with no `STRIPE_*` env vars, hit `/health` + a basic crawl/extract round-trip) — not folded into Phase 15. Belongs in **Phase 19 (Deployment & Self-Host Excellence)** alongside the `kubectl apply -k deploy/k8s/overlays/dev` and `render.yaml` work; raising it here would scope-creep into deploy infra.
- **Runtime-behavior reverse-contract test** (mock saas consumer exercising 2-3 consumed code paths) — rejected for OSS; spatula-saas's own integration suite should own behavioral pinning. Re-evaluate after first 6 months of public if drift incidents materialize.
- **`docs/runbooks/backup-restore.md`, `reverse-proxy.md`, `hardware-sizing.md`, `support-matrix.md`** — Phase 19 scope; only `upgrade.md` is created in Phase 15 to satisfy ROADMAP success #5.
- **Forensic-extractions endpoint + experimental-tag policy** — Phase 18 scope.

### Reviewed Todos (not folded)

None — `gsd-tools todo match-phase 15` returned no matches; nothing to defer.

</deferred>

---

_Phase: 15-carveout-migration-squash_
_Context gathered: 2026-05-12_
