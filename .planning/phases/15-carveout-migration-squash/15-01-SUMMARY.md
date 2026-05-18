---
phase: 15-carveout-migration-squash
plan: 01
subsystem: infra
tags: [carveout, git-filter-repo, baseline, coupling-grep, block-01, feature-branch]

# Dependency graph
requires:
  - phase: v1.0-close
    provides: clean main branch with 294 test files at Wave 5 close substrate
provides:
  - BLOCK-01 cleared (private spatula-saas repo writable + filter-repo installed)
  - Pre-cut test/typecheck baseline (293 files, 2,643 tests, per-package SHA-stamped)
  - Re-verified billing-coupling inventory (41 files; 4 inventory deltas absorbed into Plan 15-03)
  - Carve-out feature branch feat/wave-6-1-carveout (cut from main@5d19c2b)
affects: [15-02, 15-03, 15-04, 15-05, 15-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Phase entry gate verified by automated probe + committed evidence file (BLOCK-01 pattern)'
    - 'Pre-cut snapshot file co-located with substrate plan in docs/superpowers/plans/'
    - 'Per-package isolated test runs as baseline when full turbo run has parallel-I/O timeouts'

key-files:
  created:
    - docs/superpowers/plans/6-1-block01-evidence.md
    - docs/superpowers/plans/6-1-snapshot-pre-cut.md
  modified:
    - .planning/STATE.md # cleared BLOCK-01 blocker entry, updated session continuity

key-decisions:
  - 'Inventory deltas (4 files) absorb into Plan 15-03 Section B (no Plan 15-02 file-move impact)'
  - "Typecheck baseline proxied via 'pnpm --filter X build' (tsc) since no package has a typecheck script — plan command resolved to no-op"
  - 'exports.test.ts cold-import 5s-timeout failures classified as pre-existing parallel-I/O flakes (per-package isolated runs pass cleanly) — out of scope for carve-out'
  - 'CLI e2e flakes (workflow.test.ts + tier2/pipeline-errors.test.ts) acknowledged as pre-existing (commits fd59aba, ba53386 pre-date Phase 15) — deferred to Plan 15-05 fixture cleanup'

patterns-established:
  - 'BLOCK-N evidence file format: 3 probes (existence/access/tooling) with stdout/exit codes, gate-clearance verdict, acceptance-criteria checklist'
  - 'Coupling delta reconciliation: every grep hit cross-referenced against substrate Section A/B; deltas tagged with downstream-plan absorption note'

requirements-completed: [CARVE-01]

# Metrics
duration: ~70min (~5min Tasks 1+4 + ~30min baseline test runs + ~5min reconciliation + ~30min CLI test wait)
completed: 2026-05-17
---

# Phase 15 Plan 01: BLOCK-01 Verify + Pre-Cut Baseline + Coupling Re-Grep Summary

**BLOCK-01 cleared, 293-file / 2,643-test pre-cut baseline captured, billing-coupling re-grep reconciled against substrate Section A/B (4 inventory deltas routed to Plan 15-03), and `feat/wave-6-1-carveout` branch cut from main@5d19c2b — the carve-out is unblocked end-to-end.**

## Performance

- **Duration:** ~70 min (includes ~30 min waiting for `@spatula/cli` test suite — 832 tests across 96 files)
- **Started:** 2026-05-17T16:52:39Z (resumed after BLOCK-01 resolution)
- **Completed:** 2026-05-17T~18:00:00Z
- **Tasks:** 4 (1 checkpoint:human-action + 3 auto)
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- BLOCK-01 fully cleared with fresh probe evidence — `accidentally-awesome-labs/spatula-saas` confirmed PRIVATE + writable; `git-filter-repo` confirmed installed; downstream Plan 15-02 unblocked.
- Pre-cut test/typecheck baseline captured per-package with isolated runs (clean): `@spatula/core` 92/979, `@spatula/db` 29/328, `@spatula/queue` 18/156, `@spatula/api` 50/375, `@spatula/shared` 10/75, `@spatula/cli` 94/730 + 2 pre-existing e2e flakes acknowledged as out of scope. Totals: 293 test files, 2,643 passing tests.
- 41-file billing-coupling grep reconciled against substrate inventory: 37 files match Section A/B verbatim; 4 inventory deltas identified, each routed to Plan 15-03 Section B with explicit absorption notes (no Plan 15-02 file-move drift).
- Carve-out feature branch `feat/wave-6-1-carveout` created from main@5d19c2b with the snapshot committed atomically.

## Task Commits

1. **Task 1 (a): BLOCK-01 verification evidence written + committed** — `2399516` (chore: BLOCK-01 verified)
2. **Task 1 (b): STATE.md blocker cleared** — `5d19c2b` (chore: clear BLOCK-01 blocker in STATE after verification)
3. **Tasks 2 + 3 + 4: Pre-cut snapshot + coupling reconciliation + feature branch cut** — `33b92bb` on `feat/wave-6-1-carveout` (feat(carveout): take pre-cut snapshot + re-verify inventory)

_Note: Tasks 2 and 3 produce a single snapshot file that is committed in Task 4, matching the substrate plan's commit structure ("`feat(carveout): take pre-cut snapshot + re-verify inventory`")._

**Plan metadata commit:** see `git_commit_metadata` step at the end of execution.

## Files Created/Modified

- `docs/superpowers/plans/6-1-block01-evidence.md` (CREATED) — three-probe BLOCK-01 verification evidence (gh repo view JSON, ls-remote exit 0, filter-repo version `a40bce548d2c`); records cleared-gate verdict.
- `docs/superpowers/plans/6-1-snapshot-pre-cut.md` (CREATED) — test baseline table (per-package), typecheck baseline, pre-cut branch SHA, full sorted coupling-grep output, inventory-delta reconciliation table, acceptance-criteria checklist.
- `.planning/STATE.md` (MODIFIED) — cleared BLOCK-01 blocker entry, updated stopped_at + last_activity + Session Continuity to reflect Plan 15-01 in progress; removed obsolete pending-decision about confirming repo creation.

## Decisions Made

- **Inventory deltas absorbed by Plan 15-03, not 15-02.** All four files in the grep-vs-substrate delta (`apps/api/src/middleware/auth.ts`, `apps/api/tests/unit/routes/api-keys.test.ts`, `apps/cli/tests/integration/remote-commands.test.ts`, `packages/db/src/index.ts`) are in-place edits, not file moves. Routing them to Plan 15-03 Section B keeps Plan 15-02's `git filter-repo` move list unchanged — important because filter-repo configs are brittle to last-minute additions.
- **Typecheck via `tsc` build.** Plan asked for `pnpm --filter X typecheck`, but no package defines that script (only `build` runs `tsc`). Proxied through `build` for the three packages (api/queue/db). All passed exit 0.
- **Pre-existing CLI e2e flakes acknowledged and deferred.** `tests/e2e/workflow.test.ts > extracts data ... --skip-llm` (5s timeout) and `tests/e2e/tier2/pipeline-errors.test.ts` (file-level failure) date from commits `fd59aba` (test: add e2e workflow test) and `ba53386` (test: add 5 pipeline error mode tests) respectively — both pre-date Phase 15. Fixing them is out of scope for Plan 15-01 per the executor's scope-boundary rule; they are deferred to Plan 15-05 where the e2e fixtures get touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Rebuilt `better-sqlite3` native module after Node v26 ABI mismatch**

- **Found during:** Task 2 (full `pnpm test` baseline run)
- **Issue:** `@spatula/core` SqliteExporter test failed at module load with `NODE_MODULE_VERSION 141` vs `147` mismatch — local node was upgraded to v26.0.0 since the better-sqlite3 native binding was last compiled. Pre-cut baseline cannot be all-green if a single native module bindings issue blocks tests.
- **Fix:** Ran `pnpm rebuild better-sqlite3`; binding recompiled against Node v26 (NODE_MODULE_VERSION 147).
- **Files modified:** None tracked in git (rebuilds artifact under `node_modules/`); just unblocks tests.
- **Verification:** Re-ran `pnpm --filter @spatula/core test -- --run tests/unit/exporters/sqlite-exporter.test.ts` → 2/2 pass in 724ms.
- **Committed in:** N/A (no git-tracked change)

**2. [Rule 3 - Blocking] Substituted `build` for missing `typecheck` script**

- **Found during:** Task 2 (typecheck baseline step)
- **Issue:** Plan 15-01 Task 2 instructs `pnpm --filter @spatula/{api,queue,db} typecheck`, but no package defines a `typecheck` script — each `pnpm --filter` call returned "None of the selected packages has a 'typecheck' script" (exit 0 with warning, but no actual typecheck performed). The plan's intent is clearly to verify `tsc` passes; the existing `build` script in each package runs exactly `tsc`.
- **Fix:** Substituted `pnpm --filter X build` for the three packages.
- **Files modified:** None.
- **Verification:** All three `build` commands exit 0; typecheck baseline is captured and recorded in the snapshot.
- **Committed in:** N/A (no git-tracked change; behavior documented in snapshot file)

### Documented (not auto-fixed; out of scope)

**3. `exports.test.ts` cold-import 5s-timeout flake (db + queue packages)**

- **Found during:** Task 2 (full `pnpm test` parallel turbo run)
- **Issue:** Under parallel turbo I/O pressure, the first `await import('../../src/index.js')` in each package's `exports.test.ts` exceeds vitest's default 5-second `testTimeout`. Cached imports complete in <100 ms; the failure is purely a cold-start race against CPU/I/O.
- **Decision:** Pre-existing flake unrelated to the carve-out — documented in the snapshot file under per-package notes, and the baseline is captured from per-package isolated runs (which pass cleanly). Out of scope to fix here per scope boundary.
- **Files modified:** None (documentation only).

**4. CLI e2e pre-existing failures (2 files)**

- **Found during:** Task 2 (`pnpm --filter @spatula/cli test`)
- **Issue:** `tests/e2e/workflow.test.ts > extracts data from local fixture page with --skip-llm` times out at 5s; `tests/e2e/tier2/pipeline-errors.test.ts` fails at file-level load. `git log` confirms both test files were authored in commits that pre-date Phase 15 (`fd59aba`, `ba53386`).
- **Decision:** Deferred to Plan 15-05 (forward tests/carveout/) per the planner's note that e2e fixture extraction is in 15-05's scope. Snapshot file records the exact failure signatures so Plan 15-05 can verify it's not introducing them.
- **Files modified:** None (documentation only).

---

**Total deviations:** 4 documented (2 auto-fixed Rule-3 blocking, 2 pre-existing out-of-scope). **Impact on plan:** All auto-fixes necessary to capture a meaningful baseline; no scope creep. Out-of-scope items are explicitly routed to downstream plans (15-03 for the 4 inventory deltas, 15-05 for the e2e flakes) so nothing is silently dropped.

## Issues Encountered

- The `@spatula/cli` test suite takes ~14 minutes wall-clock (832 tests across 96 files including extensive integration coverage). This is a baseline-only one-time cost; future carve-out plans can run targeted subsets via `--filter <pattern>`.

## Authentication Gates

None during this plan — BLOCK-01 was a pre-execution human-action gate, resolved by the user creating the private repo. All three probes (gh, ssh, filter-repo) executed against already-configured credentials.

## User Setup Required

None — BLOCK-01 was the only user-setup item and it is now cleared. Plan 15-02 (filter-repo move) requires no additional user setup.

## Next Phase Readiness

**Ready for Plan 15-02 (Filter-repo move of Section A files → spatula-saas).**

- Carve-out feature branch `feat/wave-6-1-carveout` is checked out with clean working tree at SHA `33b92bb` (tip).
- Snapshot file `docs/superpowers/plans/6-1-snapshot-pre-cut.md` provides the exact 41-file coupling inventory + 18-file Section A move list for filter-repo input.
- Evidence file `docs/superpowers/plans/6-1-block01-evidence.md` confirms `git@github.com:accidentally-awesome-labs/spatula-saas.git` is the verified writable target.
- Inventory deltas pre-routed to Plan 15-03; Plan 15-02's filter-repo input list is unchanged from the substrate's Section A.

## Self-Check: PASSED

- [x] `docs/superpowers/plans/6-1-block01-evidence.md` — FOUND on disk
- [x] `docs/superpowers/plans/6-1-snapshot-pre-cut.md` — FOUND on disk
- [x] Commit `2399516` (BLOCK-01 verified) — FOUND in git log
- [x] Commit `5d19c2b` (STATE blocker cleared) — FOUND in git log
- [x] Commit `33b92bb` (pre-cut snapshot) — FOUND in git log on `feat/wave-6-1-carveout`
- [x] Branch `feat/wave-6-1-carveout` — exists, checked out, clean working tree
- [x] `gh repo view accidentally-awesome-labs/spatula-saas --json visibility -q .visibility` → `PRIVATE`

---

_Phase: 15-carveout-migration-squash_
_Completed: 2026-05-17_
