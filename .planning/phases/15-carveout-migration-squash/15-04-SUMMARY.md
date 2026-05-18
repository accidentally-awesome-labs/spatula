---
phase: 15-carveout-migration-squash
plan: 04
subsystem: db+ci
tags:
  [
    carveout,
    migration-squash,
    drizzle,
    pg-dump,
    ci-gate,
    namespaced-journal,
    content-store-check-constraints,
  ]

# Dependency graph
requires:
  - phase: 15-03
    provides: post-strip tenants schema (6 columns, no plan/stripeCustomerId), zero billing residue in packages/db/src/schema/
provides:
  - Single squashed migration `0000_v1_baseline.sql` (281 lines, 17 CREATE TABLE, 2 CHECK constraints, 8 enum types, 17 indices, all FKs)
  - Namespaced Drizzle migration journal `drizzle.__drizzle_migrations_oss` (separate from any future SaaS journal sharing the same Postgres)
  - PR CI gate `.github/workflows/migration-equivalence.yml` that proves squashed baseline matches expected billing-removal delta from sequential 0000-0011
  - Reusable `scripts/normalize-schema-dump.sh` (handles pg_dump 14+ \restrict/\unrestrict random-token noise)
  - Frozen fixture `scripts/migration-equivalence-expected-diff.txt` (24 sorted-deduped change lines, all billing-removal)
affects: [15-05, 15-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Namespaced migration journal: pass `migrationsTable: '__drizzle_migrations_oss'` to BOTH drizzle.config.ts (kit) AND migrate()/run-migrate.ts (runtime). The runtime arg must match the config arg or `pnpm db:migrate` and `drizzle-kit migrate` would write to different journal tables."
    - "Migration squash with non-Drizzle-modeled invariants: drizzle-kit generate only emits what's in the TypeScript schema. Raw-SQL artifacts from old migrations (e.g., CHECK constraints documented as // comments in src/schema/content.ts but applied via 0001_*.sql) must be appended to the squashed baseline AND added to meta/0000_snapshot.json under checkConstraints to avoid future-generate drift detection."
    - "PR CI equivalence gate with expected-diff fixture: when a squash intentionally drops surface (billing here), the literal 'diff must be empty' design from a pre-strip era no longer applies. Instead, freeze the expected change-only delta as a fixture and assert exact match. Any drift outside the fixture (silently dropped column, missed index, type change) still fails the gate. Preserves the original D-05 intent (detect accidental drift) while accommodating the actual carve-out reality."
    - "Normalizer for Postgres 14+ pg_dump: must strip \\restrict <random-token> and \\unrestrict <random-token> psql metacommands — pg_dump emits a fresh token per dump, otherwise every diff would be a false positive."

key-files:
  created:
    - .github/workflows/migration-equivalence.yml
    - scripts/normalize-schema-dump.sh
    - scripts/migration-equivalence-expected-diff.txt
    - packages/db/drizzle/0000_v1_baseline.sql
  modified:
    - packages/db/drizzle.config.ts
    - packages/db/src/migrate.ts
    - packages/db/src/run-migrate.ts
    - packages/db/tests/unit/migrate.test.ts
    - packages/db/drizzle/meta/_journal.json
    - packages/db/drizzle/meta/0000_snapshot.json
  deleted:
    - packages/db/drizzle/0000_previous_nova.sql
    - packages/db/drizzle/0001_good_shotgun.sql
    - packages/db/drizzle/0002_far_arachne.sql
    - packages/db/drizzle/0003_easy_silk_fever.sql
    - packages/db/drizzle/0004_faithful_sauron.sql
    - packages/db/drizzle/0005_talented_triathlon.sql
    - packages/db/drizzle/0006_spicy_human_robot.sql
    - packages/db/drizzle/0007_loving_black_tom.sql
    - packages/db/drizzle/0008_past_ted_forrester.sql
    - packages/db/drizzle/0009_needy_tempest.sql
    - packages/db/drizzle/0010_melodic_dormammu.sql
    - packages/db/drizzle/0011_young_boomer.sql
    - packages/db/drizzle/meta/0001_snapshot.json
    - packages/db/drizzle/meta/0002_snapshot.json
    - packages/db/drizzle/meta/0003_snapshot.json
    - packages/db/drizzle/meta/0004_snapshot.json
    - packages/db/drizzle/meta/0005_snapshot.json
    - packages/db/drizzle/meta/0006_snapshot.json
    - packages/db/drizzle/meta/0007_snapshot.json
    - packages/db/drizzle/meta/0008_snapshot.json
    - packages/db/drizzle/meta/0009_snapshot.json
    - packages/db/drizzle/meta/0010_snapshot.json
    - packages/db/drizzle/meta/0011_snapshot.json

key-decisions:
  - "Rule-4 reformulation of D-05 'diff must be empty' to 'diff matches frozen billing-removal fixture'. Original spec (written 2026-05-12) predates Plan 15-03's billing strip. As-written gate could never pass because DB-A (pre-strip 0000-0011) by definition contains billing tables that DB-B (post-strip squash) does not. Resolution: freeze the expected change-only delta as scripts/migration-equivalence-expected-diff.txt and compare against it exactly. Preserves D-05's actual intent (detect accidental drift) while accommodating the intentional carve-out delta."
  - "Rule-1 bug fix: re-add content_store CHECK constraints (content_at_least_one, content_not_both) to 0000_v1_baseline.sql AND meta/0000_snapshot.json. drizzle-kit generate omitted them because they live only in raw-SQL in 0001_good_shotgun.sql — the TypeScript schema (src/schema/content.ts) only documents them in a // comment. Without this fix, fresh OSS installs would silently lose the 'exactly one of content or binary_content must be set' integrity invariant."
  - 'Drizzle puts the migration journal in a separate `drizzle` schema (not `public`). Tracking table fully qualified is `drizzle.__drizzle_migrations_oss`. Tests/inspection queries must filter by tablename, not schema.'
  - "Normalizer strips Postgres 14+ \\restrict / \\unrestrict random-token psql metacommands. Without this, every dump would diff against every other dump trivially (the token changes per dump even on identical schemas)."
  - 'Workflow gate uses `git merge-base main HEAD` (or origin/main in CI) to retrieve the 12 deleted migrations from the PR base SHA. This works only while the PR base still contains them; after merge, the gate may be removed or kept as belt-and-suspenders (D-05 leaves retention to maintainer).'

patterns-established:
  - "When a squash drops a non-TS-modeled invariant, fix both the generated SQL and the snapshot.json under the appropriate constraint bucket (checkConstraints / uniqueConstraints / etc.). Snapshot update is essential — otherwise next drizzle-kit generate detects 'drift' and tries to emit either a DROP CONSTRAINT (worst case) or an unnecessary follow-up migration (best case)."
  - "Pre-existing CI-gate specs written before downstream design changes need a Rule-4 review. Resolution should preserve the original gate's INTENT (here: 'detect accidental schema drift'), not its literal pass condition ('diff must be empty'). Document the reformulation as a key-decision so reviewers understand why the gate isn't the literal spec."

requirements-completed: [CARVE-03, CARVE-04]

# Metrics
duration: ~11min
completed: 2026-05-17
---

# Phase 15 Plan 04: Migration Squash + \_\_drizzle_migrations_oss + pg_dump Equivalence Gate

**12 pre-Wave-6 migrations collapsed into a single `0000_v1_baseline.sql` (281 lines, 17 tables, 2 CHECK constraints, 8 enum types) with namespaced journal `drizzle.__drizzle_migrations_oss`; PR CI equivalence gate wired with a frozen expected-billing-removal fixture; locally proved squashed baseline produces same schema as sequential 0000-0011 + intentional billing removal, exact match to fixture.**

## Performance

- **Duration:** ~11 min (started 2026-05-17T18:27:07Z, completed ~18:38:00Z)
- **Tasks:** 3 (all auto, no checkpoints)
- **Commits:** 4 on `feat/wave-6-1-carveout`:
  - `6ea4fb7` — Task 1: namespace OSS migrations via \_\_drizzle_migrations_oss
  - `4427c80` — Task 2: squash 12 migrations into 0000_v1_baseline
  - `8d5db6c` — Rule-1 fix: preserve content_store CHECK constraints (Task 3 discovery)
  - `a44587c` — Task 3: pg_dump --schema-only equivalence gate
- **Files created:** 4 (`0000_v1_baseline.sql`, workflow, normalizer, fixture)
- **Files modified:** 6 (drizzle.config.ts, migrate.ts, run-migrate.ts, migrate.test.ts, \_journal.json, 0000_snapshot.json)
- **Files deleted:** 23 (12 old migrations + 11 old snapshots)

## Accomplishments

- **Namespaced migration journal wired.** `drizzle.config.ts`, `src/migrate.ts`, and `src/run-migrate.ts` all pass `migrationsTable: '__drizzle_migrations_oss'`. Verified post-squash: fresh `run-migrate.ts` run against an empty Postgres creates `drizzle.__drizzle_migrations_oss` (not the default `__drizzle_migrations`). Test `migrate.test.ts` updated to assert the new arg shape.
- **12 migrations squashed into 0000_v1_baseline.sql.** 281 lines, 17 CREATE TABLE statements, 17 tables produced when applied to an empty DB: `actions, api_keys, audit_log, content_store, crawl_tasks, dead_letter_queue, entities, entity_sources, exports, extractions, jobs, llm_usage, raw_pages, schemas, source_trust, tenants, user_tenants`. Zero billing tables (no `usage_records`, `subscriptions`, `stripe_*`). Zero billing columns (no `tenants.plan`, no `tenants.stripe_customer_id`, no `quotas.rateLimitTier`). Drizzle meta directory rebuilt with fresh `_journal.json` and `0000_snapshot.json`.
- **content_store CHECK constraints preserved.** Caught a real bug during Task 3's pg_dump diff: `content_at_least_one` and `content_not_both` CHECK constraints lived only in raw SQL in 0001_good_shotgun.sql (the Drizzle TypeScript schema documents them in a code comment but doesn't use Drizzle's `check()` API). drizzle-kit's auto-squash dropped them. Restored to both the baseline SQL and `meta/0000_snapshot.json` so future `drizzle-kit generate` runs don't re-detect them as drift.
- **PR CI equivalence gate live.** `.github/workflows/migration-equivalence.yml` spins two ephemeral Postgres-16 services, applies sequential 0000-0011 (retrieved from PR-base SHA via `git ls-tree`) to DB-A and the squashed baseline to DB-B, normalizes both dumps, then asserts the change-only diff matches a frozen 24-line expected-billing-removal fixture exactly. Uploads dumps + diff as artifacts on failure for debug.
- **Reusable normalizer script.** `scripts/normalize-schema-dump.sh` strips pg_dump preamble + environment SET stmts + version-comment headers + Postgres 14+ `\restrict` / `\unrestrict` random-token psql metacommands + any `__drizzle_migrations*` COPY blocks. Useful beyond this plan for any future schema-diff tooling.
- **Local end-to-end equivalence verified.** Applied 0000-0011 (retrieved from `git merge-base main HEAD`) to a local Postgres DB; applied 0000_v1_baseline.sql to a second DB; ran the full normalizer + sort-uniq pipeline; result matched the fixture exactly (`diff -u fixture actual` exits 0).

## Task Commits

| Task  | Description                                                                                    | Commit    |
| ----- | ---------------------------------------------------------------------------------------------- | --------- |
| 1     | Namespace OSS migrations via \_\_drizzle_migrations_oss (config + 2 runtime call sites + test) | `6ea4fb7` |
| 2     | Squash 12 migrations into 0000_v1_baseline for v1.0                                            | `4427c80` |
| 2-fix | Preserve content_store CHECK constraints in baseline + snapshot                                | `8d5db6c` |
| 3     | pg_dump --schema-only equivalence gate (sequential vs squashed)                                | `a44587c` |

**Plan metadata commit:** will follow this summary.

## Auth/Me Endpoint Contract Continuity

Plan 15-04 doesn't touch the auth contract from Plan 15-03. The new `tenants` schema (6 columns) materialized by `0000_v1_baseline.sql` matches the post-strip schema definition in `packages/db/src/schema/tenants.ts` exactly.

## Expected Schema Differences (Sequential vs Squashed)

The 24-line fixture at `scripts/migration-equivalence-expected-diff.txt` captures these intentional removals from the v1.0 baseline:

| Surface                                            | Removed in carve-out                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `usage_records` table                              | CREATE TABLE + all columns (id, tenant_id, dimension, quantity, period_start, period_end, reported_to_stripe, created_at) + ALTER OWNER |
| `usage_records_pkey` constraint                    | PRIMARY KEY (id)                                                                                                                        |
| `usage_records_tenant_id_tenants_id_fk` constraint | FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE                                                                        |
| `idx_usage_tenant_period` index                    | btree on (tenant_id, period_start, dimension)                                                                                           |
| `tenants.plan` column                              | character varying(20) DEFAULT 'free' NOT NULL                                                                                           |
| `tenants.stripe_customer_id` column                | text                                                                                                                                    |
| `idx_tenants_stripe_customer` index                | UNIQUE btree on (stripe_customer_id)                                                                                                    |
| `tenants.quotas` JSONB default                     | removed `rateLimitTier: 'free'` key                                                                                                     |

Additionally, two cosmetic column-reordering diffs (`content_store.created_at` and `tenants.created_at` placement) are captured in the fixture as well — they're an artifact of Drizzle's column emission order vs the historical migration order, no semantic difference.

## Deviations from Plan

### Rule-4 Architectural Reformulation

**1. [Rule 4 - Architectural] Reformulated D-05 'diff must be empty' to 'diff matches frozen fixture'**

- **Found during:** Task 3, first dry-run of pg_dump diff
- **Issue:** D-05 (CONTEXT.md, written 2026-05-12) specified the gate's pass condition as "diff must be empty". But Plan 15-03 (2026-05-17) intentionally stripped billing surface from the OSS schema. DB-A (sequential 0000-0011) applies the pre-strip schema with `usage_records` + `tenants.plan` + `tenants.stripe_customer_id` + billing indices. DB-B (squashed) applies the post-strip schema. The literal diff can never be empty by design.
- **Spec intent:** "Detect accidental schema drift in the squashed baseline." This is unchanged; only the pass condition needs adapting.
- **Reformulation:** Compare the change-only lines (sorted, deduped) against a frozen fixture at `scripts/migration-equivalence-expected-diff.txt`. The fixture freezes the _exact_ expected billing-removal delta (24 lines). Any drift outside the fixture (a silently dropped column, a missed index, a type change, an unintended renaming) still fails the gate. Maintainer can re-freeze the fixture if a later schema change is intentional.
- **Why not stop and ask:** User instruction was "make the reasonable call and continue". The reformulation preserves D-05's documented INTENT while making the gate actually runnable in the post-strip world. Documented thoroughly here for visibility.
- **Files modified:** `.github/workflows/migration-equivalence.yml` (diff step), `scripts/migration-equivalence-expected-diff.txt` (new fixture)
- **Commit:** `a44587c`

### Rule-1 Auto-fixed Bugs

**2. [Rule 1 - Bug] content_store CHECK constraints silently dropped by drizzle-kit generate**

- **Found during:** Task 3 (pg_dump local dry-run revealed CHECK constraints in sequential DB-A but absent in squashed DB-B)
- **Issue:** `content_at_least_one` and `content_not_both` CHECK constraints live only in `0001_good_shotgun.sql` (raw SQL applied via `ALTER TABLE ... ADD CONSTRAINT`). The TypeScript schema in `packages/db/src/schema/content.ts` documents them in a `//` comment but doesn't use Drizzle's `check()` API. When `drizzle-kit generate --name v1_baseline` ran, it omitted them because there's no TS source. Without fix, fresh OSS installs would silently lose the "exactly one of `content` or `binary_content` must be set" data-integrity invariant — a real correctness regression.
- **Fix:** Append both `ALTER TABLE "content_store" ADD CONSTRAINT ...` statements to `0000_v1_baseline.sql`; add both constraints to `meta/0000_snapshot.json` under `checkConstraints` so future `drizzle-kit generate` runs don't detect them as drift. Both DBs now produce the constraints in the squashed-vs-sequential diff (entries cancel out, no longer in the fixture's diff).
- **Files modified:** `packages/db/drizzle/0000_v1_baseline.sql`, `packages/db/drizzle/meta/0000_snapshot.json`
- **Commit:** `8d5db6c` (separate fix commit between Task 2 and Task 3 to keep history clean — fix discovered after Task 2 already shipped, but logically part of Task 2's deliverable)

### Rule-3 Blocking Fixes

**3. [Rule 3 - Blocker] Normalizer needed to strip Postgres 14+ \restrict/\unrestrict tokens**

- **Found during:** Task 3 (first normalizer smoke test)
- **Issue:** Postgres 14.22's `pg_dump` (and presumably 16's) emits `\restrict <16-byte-random-token>` at the start and `\unrestrict <same-token>` at the end of each schema-only dump. The token regenerates per dump, so any two dumps — even from the same DB — would diff trivially. Plan's normalizer spec didn't include these patterns.
- **Fix:** Added `-e '/^\\(un)?restrict /d'` to the sed pipeline. Also tightened the `-- PostgreSQL database dump` regex (the original `... dump /d` required a trailing space + slash; actual line is `-- PostgreSQL database dump` followed by `-- PostgreSQL database dump complete` for the footer). New regex: `^-- PostgreSQL database dump( complete)?$`.
- **Files modified:** `scripts/normalize-schema-dump.sh`
- **Commit:** `a44587c` (folded into the Task 3 commit since it's part of the same deliverable)

### Documented (not auto-fixed; out of scope)

**4. Plan's expected-table list contained `content` but the actual table name is `content_store`**

- **Found during:** Task 2 (squashed baseline inspection)
- **Issue:** Plan 15-04's `must_haves.truths` and `<interfaces>` blocks both list 17 expected tables including `content`. The actual table (from `packages/db/src/schema/content.ts`) is `pgTable('content_store', ...)`. The post-squash `\dt` shows `content_store`, matching the schema.
- **Decision:** Doc-only discrepancy in the plan, not a bug in the code. The 17-table count matches the schema (17 schema files → 17 tables); the name in the plan was shorthand. No fix needed.
- **Files modified:** None (documenting for visibility).

### Documented (potential follow-up)

**5. Workflow uses local `main` ref; CI uses `origin/main`**

- **Found during:** Task 3 local dry-run
- **Issue:** Local execution of the gate logic required `git merge-base main HEAD` because there's no `origin/main` ref in this dev clone. The committed workflow uses `origin/main` which is correct for GitHub Actions (which always fetches with origin set). No workflow change needed.
- **Files modified:** None.

---

**Total deviations:** 5 (1 Rule-4 architectural reformulation + 2 Rule-1/3 auto-fixes + 2 documented). **Impact:** Plan executed end-to-end with the equivalence gate functional. The Rule-4 reformulation is the most consequential change and is fully documented above for reviewers.

## Issues Encountered

- **D-05's literal "diff must be empty" pass condition is incompatible with Plan 15-03's billing strip.** Resolved via Rule-4 reformulation (freeze expected delta as fixture). See Deviation #1 above.
- **drizzle-kit generate omits non-TS-modeled CHECK constraints.** Caught and fixed. See Deviation #2 above.
- **Postgres 14+ pg_dump emits nondeterministic `\restrict` tokens.** Normalizer extended to strip them. See Deviation #3 above.

## Authentication Gates

None during this plan — no auth/network/secrets operations.

## User Setup Required

None for the local artifacts (workflow, normalizer, fixture, baseline). The PR CI gate runs automatically on the next PR push to main; first run on the carve-out PR is the canonical proof that the gate works in the GitHub Actions environment.

## Known Stubs

None — all artifacts are functional. The CHECK constraint addendum + snapshot update are real and tested; the expected-diff fixture was generated from a real local run (not handcrafted); the workflow has been YAML-validated and dry-run-equivalent against local Postgres.

## Next Phase Readiness

**Ready for Plan 15-05 (forward tests/carveout/ + reverse tests/private-contract/).**

- Branch `feat/wave-6-1-carveout` tip at `a44587c` (will advance to plan-metadata commit after this SUMMARY).
- Squashed baseline applies cleanly to empty Postgres in <2s; 17 tables produced; tracking table `drizzle.__drizzle_migrations_oss` created.
- pg_dump equivalence gate is committed and YAML-valid; first GitHub Actions run will be the canonical green signal when the carve-out PR opens.
- `scripts/normalize-schema-dump.sh` is available for reuse by Plan 15-05's SQL schema lint (CARVE-06 SQL component per CONTEXT.md D-03).
- `scripts/migration-equivalence-expected-diff.txt` documents the exact carve-out delta — Plan 15-05's `tests/private-contract/` schema lint can reference it to verify the carve-out boundary.

## Self-Check: PASSED

- [x] `packages/db/drizzle/0000_v1_baseline.sql` — FOUND on disk (281 lines, 17 CREATE TABLE, 2 ALTER TABLE ADD CONSTRAINT for CHECK)
- [x] `packages/db/drizzle/meta/_journal.json` — FOUND on disk
- [x] `packages/db/drizzle/meta/0000_snapshot.json` — FOUND on disk (content_store now has checkConstraints populated)
- [x] `.github/workflows/migration-equivalence.yml` — FOUND on disk, YAML valid
- [x] `scripts/normalize-schema-dump.sh` — FOUND on disk, executable bit set
- [x] `scripts/migration-equivalence-expected-diff.txt` — FOUND on disk
- [x] Commit `6ea4fb7` (Task 1: namespace OSS migrations) — FOUND in git log
- [x] Commit `4427c80` (Task 2: squash baseline) — FOUND in git log
- [x] Commit `8d5db6c` (Task 2 fix: CHECK constraints) — FOUND in git log
- [x] Commit `a44587c` (Task 3: equivalence gate) — FOUND in git log
- [x] `grep -c '__drizzle_migrations_oss' packages/db/drizzle.config.ts` returns 1
- [x] `grep -c '__drizzle_migrations_oss' packages/db/src/migrate.ts` returns 1
- [x] `grep -c '__drizzle_migrations_oss' packages/db/src/run-migrate.ts` returns 1
- [x] `grep -c '__drizzle_migrations_oss' packages/db/tests/unit/migrate.test.ts` returns 1
- [x] `ls packages/db/drizzle/*.sql | wc -l` returns 1
- [x] `grep -E 'usage_records|stripe_customer_id|"plan"|idx_tenants_stripe_customer' packages/db/drizzle/0000_v1_baseline.sql` returns 0 matches
- [x] `grep -c "CREATE TABLE" packages/db/drizzle/0000_v1_baseline.sql` returns 17
- [x] `pnpm --filter @spatula/db test` exits 0 (313 tests pass)
- [x] Local end-to-end equivalence: sequential 0000-0011 dump vs squashed dump, normalized, change-only diff matches `scripts/migration-equivalence-expected-diff.txt` byte-for-byte
- [x] `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/migration-equivalence.yml'))"` exits 0

---

_Phase: 15-carveout-migration-squash_
_Completed: 2026-05-17_
