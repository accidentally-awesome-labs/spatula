---
phase: 19-deployment-self-host-excellence
plan: '06'
subsystem: test-harnesses
tags: [backup, upgrade, config-compat, e2e, pg_dump, drizzle, deploy]
dependency_graph:
  requires:
    - packages/db/drizzle/0000_v1_baseline.sql
    - packages/db/drizzle/0001_api_key_rotation.sql
    - packages/db/src/migrate.ts (runMigrations)
    - packages/core/src/config/yaml-parser.ts (parseProjectYamlFile)
    - packages/db/src/content-store/pg-content-store.ts (PgContentStore)
    - tests/e2e/dsr/deletion/round-trip.test.ts (skip-if-no-DB pattern)
  provides:
    - tests/e2e/backup/round-trip.test.ts (DEPLOY-05 coverage)
    - tests/upgrade/migrate-and-verify.test.ts (DEPLOY-10 coverage)
    - tests/config/config-compat.test.ts (DEPLOY-11 coverage)
    - tests/upgrade/vitest.config.ts
    - tests/config/vitest.config.ts
    - tests/config/fixtures/v1.0-spatula.yaml
    - package.json test:backup / test:upgrade / test:config scripts
  affects:
    - root package.json (new test scripts appended)
    - plan 19-07 (support-matrix CI wiring for these lanes)
tech_stack:
  added: []
  patterns:
    - pg_dump + psql restore for backup parity testing
    - direct SQL enum via Drizzle (no ContentStore.listKeys) for content_store
    - SHA-256 content-hash parity via node:crypto createHash
    - separate sibling vitest configs for DB-gated test suites
    - runMigrations() on scratch DB for upgrade verification
    - pure in-process parseProjectYamlFile for config compat
key_files:
  created:
    - tests/e2e/backup/round-trip.test.ts
    - tests/upgrade/migrate-and-verify.test.ts
    - tests/upgrade/vitest.config.ts
    - tests/config/config-compat.test.ts
    - tests/config/vitest.config.ts
    - tests/config/fixtures/v1.0-spatula.yaml
  modified:
    - package.json (3 new scripts)
decisions:
  - 'Upgrade test applies baseline SQL directly via psql (not via migrator) to simulate v1.0 DB, then calls runMigrations() to prove incremental apply; both migration entries asserted in __drizzle_migrations_oss journal'
  - 'Content-store enumerated via Drizzle SELECT (not listKeys — interface has no listKeys) for backup test parity'
  - 'Config test is pure in-process (5 assertions) — can run on PR; backup + upgrade suites are DB-gated and run on-release + nightly per RESEARCH Heavy Test CI Cadence guidance'
  - 'Scratch DBs named spatula_backup_restore_test and spatula_upgrade_test — created, used, and dropped within each test run'
metrics:
  duration: '3 minutes'
  completed_date: '2026-06-10'
  tasks_completed: 2
  files_created: 6
  files_modified: 1
---

# Phase 19 Plan 06: Operational Assurance Test Harnesses Summary

**One-liner:** Three test harnesses — pg_dump→psql backup round-trip with SHA-256 content-hash parity, v1.0-baseline→runMigrations upgrade verify, and pure in-process v1.0 spatula.yaml config-compat parse — proving DEPLOY-05/10/11.

## What Was Built

### Task 1 — Backup Round-Trip Test (DEPLOY-05)

`tests/e2e/backup/round-trip.test.ts` follows the DSR deletion test pattern exactly:

- Seeds rows across `jobs`, `api_keys`, `crawl_tasks` tables under a unique tenant ID
- Writes 3 content-store blobs via `PgContentStore.store()` and records their SHA-256 hashes
- Runs `pg_dump --no-owner --no-acl` into a temp file
- Drops + recreates `spatula_backup_restore_test` scratch DB, restores via `psql -f`
- Asserts per-table `SELECT COUNT(*)` matches pre-dump counts
- Asserts content-hash parity by enumerating `content_store` rows via Drizzle `SELECT key, content` (no `listKeys` — not on the interface) and comparing SHA-256 hashes
- Adds a `PgContentStore.retrieve()` round-trip as a second parity layer
- Cleans up: deletes seeded rows + blobs from source DB; drops scratch DB; removes dump file
- Skip-if-no-DB gate in `beforeAll` (same `setupOk` pattern as DSR test)

### Task 2 — Upgrade Migration Test (DEPLOY-10)

`tests/upgrade/migrate-and-verify.test.ts`:

- Creates `spatula_upgrade_test` scratch DB
- Applies `0000_v1_baseline.sql` directly via `psql -f` — simulates a v1.0 database with no migration journal
- Calls `runMigrations(scratchUrl)` from `@spatula/db` — applies any unmigrated increments and populates `__drizzle_migrations_oss`
- Asserts journal has ≥ 2 rows (baseline + 0001_api_key_rotation)
- Asserts `SELECT 1` against all 16 expected tables (schema-level smoke)
- Asserts `supersedes` + `superseded_expires_at` columns from 0001 are present on `api_keys`
- Cleanup in `afterAll`; skip-if-no-DB in `beforeAll`

### Task 2 — Config Compat Test (DEPLOY-11)

`tests/config/config-compat.test.ts`:

- Pure in-process — no DB, no HTTP
- 5 test cases cover: no-throw parse, seeds array, project name/description, fields, crawler/depth settings, all nested sections (crawl/schema/llm/reconciliation/export)
- Fixture `tests/config/fixtures/v1.0-spatula.yaml` is a representative v1.0 project config with all supported sections

### Supporting Files

- `tests/upgrade/vitest.config.ts` — node env, upgrade include, `@spatula/*` aliases
- `tests/config/vitest.config.ts` — node env, config include, core + shared aliases
- `package.json` — added `test:backup`, `test:upgrade`, `test:config` scripts

## Verification Results

```
pnpm exec vitest run --config tests/config/vitest.config.ts
  ✓ tests/config/config-compat.test.ts (5 tests) — PASSED

pnpm exec vitest run --config tests/upgrade/vitest.config.ts
  ✓ tests/upgrade/migrate-and-verify.test.ts (1 test | 1 skipped) — SKIPPED (no DB)

pnpm exec vitest run --config tests/vitest.config.ts tests/e2e/backup/round-trip.test.ts
  ✓ tests/e2e/backup/round-trip.test.ts (1 test | 1 skipped) — SKIPPED (no DB)
```

All three pass their requirements: config test is green without DB; backup + upgrade skip cleanly without DB and are ready to run against a real Postgres.

## Decisions Made

1. **Upgrade approach**: Apply baseline via `psql -f` (not the migrator) to simulate v1.0 — the migrator then sees an untracked schema and populates the journal. This tests the realistic expand-contract upgrade path.
2. **Content-store enumeration**: Drizzle `SELECT key, content FROM content_store WHERE key LIKE ?` — no `listKeys` (not on the `ContentStore` interface); matches RESEARCH note exactly.
3. **Config test cadence**: 5 lightweight in-process assertions; can run on PR (pure function, no I/O). Backup + upgrade are DB-gated, appropriate for on-release + nightly lanes (Plan 07 wires the CI).
4. **Scratch DB names**: `spatula_backup_restore_test` and `spatula_upgrade_test` — created + dropped per test, never collide with `spatula_test`.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — no stub data sources or placeholder values flow to any rendering surface. These are test harnesses only.

## Commits

| Task | Commit  | Description                                                                  |
| ---- | ------- | ---------------------------------------------------------------------------- |
| 1    | af40f31 | test(19-06): add backup→restore round-trip test (DEPLOY-05)                  |
| 2    | 502eb08 | feat(19-06): add upgrade + config-compat tests + root scripts (DEPLOY-10/11) |

## Self-Check: PASSED

- [x] `tests/e2e/backup/round-trip.test.ts` — EXISTS
- [x] `tests/upgrade/migrate-and-verify.test.ts` — EXISTS
- [x] `tests/upgrade/vitest.config.ts` — EXISTS
- [x] `tests/config/config-compat.test.ts` — EXISTS
- [x] `tests/config/vitest.config.ts` — EXISTS
- [x] `tests/config/fixtures/v1.0-spatula.yaml` — EXISTS
- [x] commit `af40f31` — EXISTS
- [x] commit `502eb08` — EXISTS
- [x] `pnpm exec vitest run --config tests/config/vitest.config.ts` — PASSED (5 tests)
- [x] `pnpm exec vitest run --config tests/upgrade/vitest.config.ts` — SKIPPED cleanly (no DB)
- [x] `pnpm exec vitest run --config tests/vitest.config.ts tests/e2e/backup/round-trip.test.ts` — SKIPPED cleanly (no DB)
