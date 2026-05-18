# Phase 15: Carve-out & Migration Squash - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-12
**Phase:** 15-carveout-migration-squash
**Areas discussed:** Plan source-of-truth, CARVE-06 depth + CI cadence, Migration squash equivalence proof, Carve-out PR shape

---

## Plan Source-of-Truth

| Option                              | Description                                                                                                                                                                                  | Selected |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Hybrid: plan as input + delta tasks | Planner reads 2026-04-20 plan as substrate, adds delta tasks for ROADMAP-new items (residual-risk doc, CI cadence, policy commits). Preserves 2429 lines of decisions; closes the v1.1 gaps. | ✓        |
| Express PRD: use plan verbatim      | `/gsd:plan-phase 15 --prd <path>`. Skip research; planner trusts pre-drafted as final. Fastest path; risks missing v1.1 ROADMAP additions.                                                   |          |
| Re-plan fresh from CONTEXT          | Discard pre-drafted; researcher + planner start clean from CONTEXT.md decisions. Most rigorous; throws away 2 months of detail work.                                                         |          |

**User's choice:** Hybrid: plan as input + delta tasks (Recommended)
**Notes:** ROADMAP explicitly says "reconcile with phase-plan when discuss-phase/plan-phase fires." Hybrid is the literal interpretation: keep what's locked, fill the gaps the new ROADMAP added.

---

## CARVE-06 Reverse-Contract Depth

| Option                               | Description                                                                                                                                                                                                                                | Selected |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| TS + SQL schema lint + doc residuals | Keep TS-surface test. Add a SQL diff check (drizzle introspect snapshot of OSS schema vs saved baseline) — catches FK/RLS/trigger drift. Runtime behavior drift acknowledged in docs/private-contract.md residual-risk register. Best ROI. | ✓        |
| TS surface only + doc all residuals  | Plan as-drafted. docs/private-contract.md lists SQL/runtime/RLS as acknowledged residual risks; trust manual review + spatula-saas integration tests to catch.                                                                             |          |
| TS + SQL lint + narrow runtime smoke | Add a tiny runtime suite that exercises 2-3 consumed code paths from a mock saas consumer (e.g., quota check call signature, repository return shape). Highest cost; closest to spec intent.                                               |          |

**User's choice:** TS + SQL schema lint + doc residuals (Recommended)
**Notes:** Runtime smoke is rejected for OSS — spatula-saas's own integration suite owns behavioral pinning. Re-evaluate after first 6 months of public if drift incidents materialize.

## CARVE-06 CI Cadence

| Option                 | Description                                                                                                                                                                       | Selected |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Every PR               | Instant drift signal. ROADMAP success #2 says 'mocked private consumer... breaks the build when a consumed export is silently removed' — implies PR-time. Adds ~30s-2min per run. | ✓        |
| Nightly + release-gate | Cheaper CI minutes; drift caught within 24h. Risk: feature-branch landings can break private consumer until next nightly.                                                         |          |
| Release-gate only      | Runs only when cutting a release tag. Cheapest. Highest blast radius — drift accumulates between releases.                                                                        |          |

**User's choice:** Every PR (Recommended)
**Notes:** ROADMAP wording "breaks the build when... silently removed" implies PR-time gate.

---

## Migration Squash Equivalence Proof

| Option                                          | Description                                                                                                                                                                                                                                       | Selected |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| pg_dump --schema-only diff in PR CI             | Spin two ephemeral Postgres: DB-A applies 0000-0011, DB-B applies 000_v1_baseline.sql. pg_dump --schema-only both, normalize (strip migration journal rows + timestamps), diff. Zero-diff = green. Canonical, deterministic, gates PR merge once. | ✓        |
| Drizzle introspect snapshot diff                | drizzle-kit introspect against both DBs, deep-diff JSON snapshots. Tooling-aware; trusts drizzle's snapshot format. Easier to read but less authoritative.                                                                                        |          |
| Belt-and-suspenders: pg_dump + drizzle + manual | Run pg_dump diff AND drizzle snapshot diff AND require human sign-off on baseline. Highest assurance. Largest engineering cost for a one-shot squash.                                                                                             |          |
| Manual review only                              | Engineer eyeballs 000_v1_baseline.sql against migration history. Cheap; error-prone. Not recommended for a baseline that ships v1.                                                                                                                |          |

**User's choice:** pg_dump --schema-only diff in PR CI (Recommended)
**Notes:** pg_dump is canonical ground truth; drizzle snapshot trusts drizzle internals. Belt-and-suspenders rejected as over-engineering for a one-shot squash.

---

## Carve-out PR Shape

| Option                             | Description                                                                                                                                                                                                                               | Selected |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Single PR, organized commits       | One feat branch → 27 per-task commits grouped by stage (filter-repo → delete → in-place edits → tests → docs) → squash-merge OR merge-commit. Atomic switchover; reviewable commit-by-commit; clean revert. Matches plan as-drafted.      | ✓        |
| Stacked PRs (graphite/spr-style)   | Split into 3-4 stacked PRs: (1) move-files-to-private, (2) strip-coupling-from-OSS, (3) squash-migrations, (4) test-suites. Easier review per PR; risk: partial merge leaves OSS broken (e.g., billing routes mounted but services gone). |          |
| Single PR, single squash commit    | 27 commits squashed to one merge commit. Smallest history footprint; nukes per-task context. Hard to bisect later.                                                                                                                        |          |
| Sequenced PRs to main (multi-week) | Land each stage as a separate PR over weeks. OSS server stays partially-broken between merges. Not viable pre-public-flip.                                                                                                                |          |

**User's choice:** Single PR, organized commits (Recommended)
**Notes:** Merge strategy further refined in CONTEXT.md D-08 → merge-commit (not squash) to preserve per-task bisect history.

---

## Claude's Discretion

- `docs/private-contract.md` format (ADR-style vs risk register vs surface contract)
- `docs/runbooks/` directory structure (Phase 15 only creates `upgrade.md`)
- SQL schema lint implementation (`drizzle-kit introspect` JSON vs normalized `pg_dump` snapshot)
- Per-stage commit count granularity (27 plan target; trivial merges allowed if reviewability improves)
- BLOCK-01 verification step format (Task 1 fail-fast if `spatula-saas` not writable)

## Deferred Ideas

- Post-carve OSS-only smoke deploy → Phase 19
- Runtime-behavior reverse-contract test → revisit post-public if drift incidents materialize
- Other runbooks (`backup-restore.md`, `reverse-proxy.md`, `hardware-sizing.md`, `support-matrix.md`) → Phase 19
- Forensic-extractions endpoint + experimental-tag policy → Phase 18
