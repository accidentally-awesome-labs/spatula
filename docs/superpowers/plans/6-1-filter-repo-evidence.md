# 6-1 filter-repo extraction evidence — 2026-05-17T17:36:33Z

**Phase:** 15 (carveout-migration-squash) Plan 15-02
**Generator:** gsd-executor (Plan 15-02 Tasks 1 + 2)
**Operation:** `git filter-repo` on a mirror clone (OSS history NOT rewritten — spec §3.1.4)

---

## Extracted paths (allowlist)

Source list: `/tmp/saas-paths.txt` (transient, regenerated from this file's embedded list below).

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
- docs/superpowers/plans/2026-04-06-wave-5-2-billing-metering.md

**Total:** 19 paths (18 Section A source files + 1 historical implementation-plan doc).

## Extraction metrics

| Metric | Value |
|---|---|
| Commits carried over | **13** (all distinct billing/metering commits, including code review fix-ups and the test-gap closure commit) |
| Filter-repo runtime | 0.58s (parsing 786 commits → rewriting → repack) |
| Mirror HEAD SHA after filter-repo | `c02d3335aa9308600449378387d5611a19c5507d` |
| Source OSS HEAD SHA at extraction time | `aca52e2f9665c44c608b73b04a74d962f7913a4c` (tip of `feat/wave-6-1-carveout`, pre-Task-3-deletion) |
| Files in filtered tree | 19 (exact match — `diff /tmp/saas-paths.txt /tmp/saas-ls-files.txt` returns no diff) |

## Private repo state

| Property | Value |
|---|---|
| URL | https://github.com/accidentally-awesome-labs/spatula-saas |
| Push command | `git push --mirror saas` from `/tmp/spatula-mirror` |
| Push outcome | `* [new branch] feat/wave-6-1-carveout -> feat/wave-6-1-carveout` + `* [new branch] main -> main` (both refs pushed, both at SHA `c02d333`) |
| Pushed at | 2026-05-17T17:36:33Z |
| `git ls-remote ... HEAD` | `c02d3335aa9308600449378387d5611a19c5507d HEAD` (exit 0) |
| Sanity re-clone (`/tmp/saas-verify`) | 19 files, exact byte-for-byte match against `/tmp/saas-ls-files.txt` → **REMOTE MATCHES LOCAL FILTERED MIRROR** |

## Default branch caveat (benign)

GitHub auto-selected `feat/wave-6-1-carveout` as the default branch on `accidentally-awesome-labs/spatula-saas` because that was the first branch GitHub indexed during the mirror push (alphabetically before `main`). Both branches contain the identical 19-file tree at SHA `c02d333` — there is **no content divergence**. The repo owner can switch the default to `main` in GitHub Settings → Branches at any time; doing so is not required for the carve-out to be correct.

## Operational invariants asserted

1. **Mirror-clone-only** — `git filter-repo` operated on `/tmp/spatula-mirror`, never on `/Users/salar/Projects/spatula`. OSS forward-history is intact and unrewritten.
2. **OSS unchanged at extraction time** — the OSS working repo HEAD (`aca52e2`) was identical before and after the filter-repo + push operations. The only OSS commits after this point come from Task 3 (forward deletion) and the evidence-file commit (this file).
3. **Allowlist authority** — every file in the spatula-saas tree is present in `/tmp/saas-paths.txt`; every file in `/tmp/saas-paths.txt` is present in the spatula-saas tree. No extras, no missing.
4. **Empty-target precondition honored** — `git ls-remote git@github.com:accidentally-awesome-labs/spatula-saas.git` returned 0 lines before the push (verified at 2026-05-17T17:34). Push was clean-slate, not force-merged.

## Plan acceptance criteria — verification

| Criterion | Status | Evidence |
|---|---|---|
| `/tmp/spatula-mirror` exists and is a valid git repo | ✅ | `cd /tmp/spatula-mirror && git rev-parse --git-dir` returned `.` (exit 0) |
| Filtered tree contains exactly the allowlist | ✅ | 19 files via `git ls-tree -r --name-only HEAD`; `diff` returns no output |
| `git ls-remote ... HEAD` exits 0 with a SHA | ✅ | `c02d3335aa9308600449378387d5611a19c5507d HEAD` |
| Remote HEAD SHA matches mirror HEAD SHA | ✅ | Both `c02d3335aa9308600449378387d5611a19c5507d` |
| Sanity re-clone diff: REMOTE MATCHES LOCAL FILTERED MIRROR | ✅ | Diff returned no output; "REMOTE MATCHES LOCAL FILTERED MIRROR" printed |
| Evidence file committed | ✅ | This file (commit in same task) |

## Plan acceptance criterion — off-by-one note

Plan 15-02 Task 1 acceptance criterion reads `git ls-files | wc -l returns 20 (19 source files + 1 historical plan)`. The substrate plan's path-allowlist contains **19 lines total**, of which 18 are source files and 1 is the historical plan doc — total 19, not 20. The "20" appears to be a planner double-count error (18 + 1 = 19, not 20). The filter-repo output (19 files) and the diff-check (exact match against the 19-line allowlist) jointly satisfy the stronger version of the criterion ("every allowlist entry present; no extras"). No deviation from the substrate, only from a derivative criterion in 15-02-PLAN.md.

Also: `git ls-files` on a bare/mirror repo returns no output (no working tree). The correct enumeration command is `git ls-tree -r --name-only HEAD`, which was used for all checks above.

---

**Conclusion:** Section A files (history preserved, 13 commits) now live in `accidentally-awesome-labs/spatula-saas`. The OSS forward-deletion commit (Plan 15-02 Task 3) is the next step. OSS history was not rewritten by this operation.
