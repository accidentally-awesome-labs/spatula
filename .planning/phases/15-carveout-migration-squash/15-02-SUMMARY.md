---
phase: 15-carveout-migration-squash
plan: 02
subsystem: infra
tags: [carveout, git-filter-repo, billing, stripe, metering, history-extraction, spatula-saas, mirror-clone]

# Dependency graph
requires:
  - phase: 15-01
    provides: BLOCK-01 verified writable private remote + feat/wave-6-1-carveout branch + pre-cut baseline
provides:
  - Section A history extracted to accidentally-awesome-labs/spatula-saas (13 commits, 19 paths preserved)
  - OSS forward-deletion commit for the 18 Section A source files (history NOT rewritten on OSS)
  - Evidence note 6-1-filter-repo-evidence.md (allowlist, mirror HEAD, push outcome, sanity re-clone diff)
  - Spatula-saas repo populated and verifiable via ls-remote / gh repo view / clone byte-match
affects: [15-03, 15-04, 15-05, 15-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mirror-clone filter-repo pattern: operate on /tmp/spatula-mirror, never the working repo (spec §3.1.4)"
    - "Forward-deletion (not history rewrite) on OSS — Section A leaves OSS via a single deletion commit, full history lives on in private repo"
    - "Allowlist-driven extraction with byte-exact sanity re-clone diff against /tmp/saas-ls-files.txt as the verification gate"
    - "Bounded broken-state pattern: Task 3 intentionally leaves the OSS TypeScript build broken (5 stale-import files) — Plan 15-03 fixes; branch tip will be consistent at PR D-07 cut"

key-files:
  created:
    - docs/superpowers/plans/6-1-filter-repo-evidence.md
  modified: []
  deleted:
    - apps/api/src/routes/billing.ts
    - apps/api/src/routes/stripe-webhook.ts
    - apps/api/src/billing/stripe-client.ts
    - apps/api/tests/unit/routes/billing.test.ts
    - apps/api/tests/unit/routes/stripe-webhook.test.ts
    - apps/api/tests/unit/billing/stripe-client.test.ts
    - packages/shared/src/billing/index.ts
    - packages/shared/src/billing/tiers.ts
    - packages/core/src/billing/quota-enforcer.ts
    - packages/core/src/billing/quota-enforcer.test.ts
    - packages/core/src/billing/billing-usage-recorder.ts
    - packages/core/src/billing/billing-usage-recorder.test.ts
    - packages/core/src/billing/index.ts
    - packages/queue/src/metering-worker.ts
    - packages/queue/tests/unit/metering-worker.test.ts
    - packages/db/src/schema/usage-records.ts
    - packages/db/src/repositories/usage-record-repository.ts
    - packages/db/tests/unit/repositories/usage-record-repository.test.ts

key-decisions:
  - "GitHub default branch on spatula-saas is feat/wave-6-1-carveout (alphabetically first push), not main — benign because both refs point to the same 19-file SHA c02d333; owner can flip later in GitHub Settings"
  - "Off-by-one in Plan 15-02 Task 1 acceptance criterion (says 20, allowlist is 19) reconciled in favor of substrate authority — 19 files is correct"
  - "Bare/mirror repo verification uses git ls-tree -r --name-only HEAD instead of git ls-files (which returns empty without a working tree)"
  - "Forward-deletion commit landed without intermediate typecheck/test (substrate Task 4 Step 3 calls for it, but Plan 15-02 explicitly defers stale-import fix-up to Plan 15-03 — running typecheck here would intentionally fail and add no signal)"

patterns-established:
  - "Mirror-clone filter-repo: 4 lines (cd /tmp; rm -rf X; git clone --mirror SOURCE X; cd X; git filter-repo ...) keeps the destructive operation off the working repo by construction"
  - "Empty-target precondition gate: ls-remote returns zero lines before push, guarantees git push --mirror is clean-slate (no force-merge ambiguity)"
  - "Byte-match verification: clone the pushed remote into a scratch dir, diff its sorted ls-files against the filtered mirror's sorted tree — REMOTE MATCHES LOCAL FILTERED MIRROR is the gate"

requirements-completed: [CARVE-01]

# Metrics
duration: ~4min
completed: 2026-05-17
---

# Phase 15 Plan 02: Filter-repo Section A → spatula-saas + OSS Forward Deletion Summary

**18 Section A billing/Stripe/metering source files (plus 1 historical plan doc) extracted with 13 commits of preserved history into the private `accidentally-awesome-labs/spatula-saas` repo via `git filter-repo` on a mirror clone, followed by a single forward-deletion commit on `feat/wave-6-1-carveout` removing the same files from OSS — OSS history NOT rewritten.**

## Performance

- **Duration:** ~4 min (filter-repo extraction is sub-second; bulk of wall-clock was verification)
- **Started:** 2026-05-17T17:34:17Z
- **Completed:** 2026-05-17T17:38:53Z
- **Tasks:** 3 auto
- **Files created:** 1 (evidence note)
- **Files deleted (OSS):** 18 (4 emptied directories also removed: `apps/api/src/billing/`, `apps/api/tests/unit/billing/`, `packages/shared/src/billing/`, `packages/core/src/billing/`)
- **Files pushed (spatula-saas):** 19 (18 source + 1 plan doc, with full history of 13 commits)
- **Commits on `feat/wave-6-1-carveout` in this plan:** 2 (`f066ae1`, `20318a6`)

## Accomplishments

- **Section A extracted with history preserved.** All 18 source files plus the historical implementation-plan doc (`docs/superpowers/plans/2026-04-06-wave-5-2-billing-metering.md`) now live in `accidentally-awesome-labs/spatula-saas` at mirror HEAD `c02d3335aa9308600449378387d5611a19c5507d`, with 13 commits of authentic billing/metering development history retained (from the original Wave 5-2 work — see commit log in evidence file).
- **OSS forward-delete landed cleanly.** Commit `20318a6` removes exactly 18 source files (plus 4 emptied parent directories) from `feat/wave-6-1-carveout`. The 19th allowlist entry (the historical plan doc) intentionally stays in OSS per the substrate's Section A definition.
- **OSS history sacrosanct.** No `git filter-repo`, no force-push, no rebase on the OSS working repo — only forward commits added. The four commits between `main` and `feat/wave-6-1-carveout` (`33b92bb`, `aca52e2`, `f066ae1`, `20318a6`) are all clean linear additions.
- **Verification gates green.** All 5 Task 3 acceptance criteria + all 4 plan-level verification checks passed. Sanity re-clone byte-matched the filtered mirror.

## Task Commits

1. **Task 1: Mirror clone + git filter-repo with Section A allowlist** — No git commit (operations on transient `/tmp/spatula-mirror` only). Mirror HEAD after filter-repo: `c02d333`.
2. **Task 2: Push filtered mirror to spatula-saas + write evidence** — `f066ae1` (feat(carveout): filter-repo extraction evidence for spatula-saas)
3. **Task 3: Delete Section A files from OSS + commit forward deletion** — `20318a6` (feat(carveout): delete Section A billing files from OSS (history preserved in spatula-saas))

**Plan metadata commit:** Will follow this summary as the final commit.

## Files Created/Modified

- `docs/superpowers/plans/6-1-filter-repo-evidence.md` (CREATED) — 86-line audit trail: allowlist (19 paths), extraction metrics (13 commits, 0.58s runtime, mirror HEAD `c02d333`), private-repo state (push outcome, ls-remote confirmation, sanity re-clone match), operational invariants (mirror-only, OSS unchanged, allowlist authoritative, empty-target precondition), and plan acceptance criteria verification table.

**Deletions** — 18 source files (enumerated in frontmatter `deleted` field) plus emptied parent dirs `apps/api/src/billing/`, `apps/api/tests/unit/billing/`, `packages/shared/src/billing/`, `packages/core/src/billing/`.

## Commits Carried Into spatula-saas (13)

In reverse chronological order on the filtered mirror's HEAD:

| # | SHA | Subject |
|---|---|---|
| 1 | `c02d333` | test: fix 10 suspect tests across platform |
| 2 | `2860622` | test: close critical test gaps for billing quota wiring |
| 3 | `0bc8e67` | feat(billing): wire QuotaEnforcer into job-manager + crawl worker + LLM recorder + export orchestrator |
| 4 | `d3ccff2` | fix: address code review findings — validate plan from Stripe, add stripe_customer_id index, fix idempotency key, safe metering deps construction |
| 5 | `1ec640b` | feat(queue): add hourly metering worker for Stripe usage reporting |
| 6 | `a0a0448` | feat(api): add Stripe webhook handler with signature verification, register billing routes |
| 7 | `5992774` | feat(api): add billing routes (subscription, invoices, portal) and wire AppDeps |
| 8 | `a6b057b` | feat(api): add SpatulaStripeClient wrapper using Billing Meter Events API |
| 9 | `79bba80` | feat(core): add QuotaEnforcer service for billing dimension checks |
| 10 | `b6be599` | feat(db): add usage_records schema and UsageRecordRepository |
| 11 | `3f9ea29` | fix(docs): address code review findings for Wave 5-2 plan |
| 12 | `53d9389` | feat(shared): add billing tier constants and types |
| 13 | `7f3f67d` | docs: add Wave 5-2 billing & metering implementation plan |

All 13 commits retained their original authorship and timestamps (filter-repo's default behavior). These are the **authoritative private-repo history** for billing/metering; the same SHAs no longer appear on OSS feature-branch reachability (because the files they touch are gone, those commits are pruned from any OSS ancestry walk).

## Decisions Made

- **Default branch on spatula-saas is `feat/wave-6-1-carveout`, not `main`.** GitHub picks the alphabetically first branch when a repo is empty + first push is `--mirror`. Both refs point to identical 19-file SHA `c02d333` — there is no content divergence. Switching to `main` is a one-click GitHub Settings → Branches change that the repo owner can do anytime; not required for carve-out correctness.
- **Off-by-one in Plan 15-02 Task 1 acceptance criterion reconciled.** Plan says `git ls-files | wc -l returns 20 (19 source files + 1 historical plan)`. Substrate allowlist contains 19 lines total (18 source + 1 plan = 19, not 20). The "20" is a planner double-count artifact. Verified via exact byte-match: `diff /tmp/saas-paths.txt /tmp/saas-ls-files.txt` returns empty. Substrate is authoritative.
- **Bare/mirror repo enumeration uses ls-tree, not ls-files.** `git ls-files` on a bare repo with no working tree returns zero output. Used `git ls-tree -r --name-only HEAD` for all tree-content verifications.
- **No intermediate typecheck before the deletion commit.** Substrate Task 4 Step 3 runs `pnpm --filter @spatula/api typecheck` between deletion and commit, but Plan 15-02 explicitly defers stale-import fix-up to Plan 15-03. Running typecheck here would intentionally fail (5 source files still import deleted modules) and add no diagnostic value — it would just be a noisy red. Plan 15-03 will run a full typecheck once it has rewired the imports.

## Deviations from Plan

### Reconciled (substrate vs. plan)

**1. [Plan-text correction] Task 1 acceptance criterion off-by-one (`wc -l returns 20`)**
- **Found during:** Task 1 (post-filter-repo verification)
- **Issue:** Plan 15-02 Task 1 expects `git ls-files | wc -l` to return 20. Substrate allowlist is 19 lines (18 source + 1 plan doc), and filter-repo produced exactly 19 files in the filtered tree.
- **Resolution:** Used the stronger acceptance criterion — `diff <(sort allowlist) <(sort ls-files)` must return no output. Diff returned EXACT MATCH (19 ↔ 19). Documented in evidence file under "Plan acceptance criterion — off-by-one note."
- **Files modified:** None.
- **Verification:** Both criteria from the plan text ("every line in allowlist appears in ls-files" + "no file in ls-files is missing from allowlist") satisfied.

**2. [Plan-text adaptation] `git ls-files` swapped for `git ls-tree -r HEAD` on bare/mirror repo**
- **Found during:** Task 1 (initial verification command from plan text returned empty)
- **Issue:** Plan called `cd /tmp/spatula-mirror && git ls-files | sort > /tmp/saas-ls-files.txt` — but `/tmp/spatula-mirror` is a bare/mirror repo with no working tree, so `git ls-files` returns nothing.
- **Resolution:** Switched to `git ls-tree -r --name-only HEAD | sort > /tmp/saas-ls-files.txt`, which enumerates tree contents directly from the commit object. Produced the expected 19 files.
- **Files modified:** None (just a different command).
- **Verification:** Output matches what `git ls-files` would have shown on a non-bare clone.

### Deferred (out of scope for this plan)

**3. Stale imports in 5 OSS source files (Plan 15-03 territory)**
- **Found during:** Task 3 (post-deletion sanity grep)
- **Files with stale imports:**
  - `apps/api/src/app.ts` — `billingRoutes`, `stripeWebhookRoutes` mounts (+ plan-loading middleware referencing deleted tiers)
  - `apps/api/src/types.ts` — `BillingUsageRecorder` import + billing scopes in `AUTH_SCOPES`
  - `packages/db/src/index.ts` + `packages/db/src/schema/index.ts` — `UsageRecord`, `DimensionUsage`, `UsageRecordRepository` re-exports
  - `packages/queue/src/worker-entrypoint.ts` — `metering-worker` import
- **Decision:** Plan 15-02 explicitly scopes "OSS TypeScript build is BROKEN due to stale imports — Plan 15-03 fixes this; the inconsistency is bounded to within the single PR." Not auto-fixed here; routed to Plan 15-03's "Section B in-place strip" tasks (substrate Tasks 3, 5, 9, 11, 13). Plan 15-01's 4 inventory deltas (`auth.ts`, `api-keys.test.ts`, `remote-commands.test.ts`, `packages/db/src/index.ts`) overlap with this list — they are the same in-place edits, already routed to Plan 15-03.

---

**Total deviations:** 2 plan-text reconciliations (both adapt verification commands to the actual repo state without altering the substrate's intent), 0 auto-fixes (Rules 1/2/3 not triggered — the broken build is intentional + bounded), 0 architectural decisions needed.

**Impact on plan:** Zero scope creep. Substrate behavior matches the spec; only the plan's derivative verification commands needed minor adaptation to fit a bare/mirror repo's command surface.

## Issues Encountered

- **First-attempt `git ls-files` returned zero output.** Resolved by switching to `git ls-tree -r HEAD` (correct command for bare repos). Documented as deviation #2. No data lost — filter-repo had succeeded; only the verification command needed adjustment.
- **GitHub auto-selected `feat/wave-6-1-carveout` as default branch on spatula-saas.** Cosmetic only — both branches contain identical trees at SHA `c02d333`. Flagged in evidence file and decisions list for the repo owner to flip if desired.

## Authentication Gates

None — `gh` and SSH credentials for `accidentally-awesome-labs` were configured during BLOCK-01 verification in Plan 15-01. All operations (mirror push, ls-remote, gh repo view, scratch re-clone) succeeded against existing creds.

## User Setup Required

None — Plan 15-02 is fully automated. The remote was provisioned during BLOCK-01 (Plan 15-01 prerequisite); this plan only consumed it.

## Known Stubs

None — no UI-rendering placeholder values introduced. This is a pure git-operations plan; the only file authored is the evidence note, and it is substantive (86 lines of audit trail).

## Next Phase Readiness

**Ready for Plan 15-03 (Section B in-place strip + 4 inventory deltas from Plan 15-01).**

- `feat/wave-6-1-carveout` tip at `20318a6` with 18 Section A files deleted and evidence committed.
- OSS TypeScript build is **intentionally broken** at 5 known source files (enumerated in deviation #3 above) — Plan 15-03's task list already targets these via substrate Section B work + the 4 Plan-15-01 inventory deltas.
- `spatula-saas` is populated, reachable, byte-verified — downstream private-side work (when it begins) has the substrate it needs.
- No state left in `/tmp/` is required by downstream plans; `/tmp/spatula-mirror`, `/tmp/saas-paths.txt`, `/tmp/saas-ls-files.txt` etc. can be cleaned by macOS or manually whenever convenient (mirror reproducible by re-running Task 1 if forensic re-check ever needed).

## Self-Check: PASSED

- [x] `docs/superpowers/plans/6-1-filter-repo-evidence.md` — FOUND on disk
- [x] Commit `f066ae1` (filter-repo evidence) — FOUND in git log on `feat/wave-6-1-carveout`
- [x] Commit `20318a6` (forward-deletion) — FOUND in git log on `feat/wave-6-1-carveout`
- [x] All 18 Section A source files — confirmed deleted via `git ls-files | grep` returning empty
- [x] `git ls-remote git@github.com:accidentally-awesome-labs/spatula-saas.git HEAD` returns SHA `c02d3335aa9308600449378387d5611a19c5507d`
- [x] `gh repo view accidentally-awesome-labs/spatula-saas --json defaultBranchRef -q .defaultBranchRef.name` returns `feat/wave-6-1-carveout` (branch present; default flagged as benign caveat)
- [x] Sanity re-clone: 19 files, byte-match against filtered mirror
- [x] OSS history NOT rewritten: only 4 forward commits between `main` (`5d19c2b`) and `feat/wave-6-1-carveout` (`20318a6`), all linear additions

---
*Phase: 15-carveout-migration-squash*
*Completed: 2026-05-17*
