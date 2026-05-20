---
phase: 17-browser-auth-sse-cors
plan: "01"
subsystem: db-schema, core-types, config, test-scaffolding
tags: [migration, error-codes, rate-limits, scaffolding, tdd]
dependency_graph:
  requires: []
  provides:
    - api_keys.supersedes column (uuid, self-FK) for rotation lineage
    - api_keys.superseded_expires_at column (timestamptz) for grace-window
    - ErrorCode.RESOURCE_NOT_FOUND mapped to HTTP 404
    - rate-limits.yaml entries for SSE events + api-key rotate routes
    - tests/isolation/vitest.config.ts for cross-tenant isolation suite
    - test directory scaffolds for downstream plans 17-02..17-07
  affects:
    - packages/db (schema + migration)
    - packages/core-types (frozen ErrorCode enum)
    - config/rate-limits.yaml (boot-time rate-limit config)
    - tests/isolation/, tests/e2e/, apps/api/tests/
tech_stack:
  added: []
  patterns:
    - Drizzle expand-only migration (ADD COLUMN, no DROP)
    - TDD RED → GREEN for additive enum entry
    - Vitest config aliasing @spatula/* workspace packages
key_files:
  created:
    - packages/db/drizzle/0001_api_key_rotation.sql
    - packages/db/drizzle/meta/0001_snapshot.json
    - tests/isolation/vitest.config.ts
    - apps/api/tests/sse/.gitkeep
    - apps/api/tests/cors/.gitkeep
    - apps/api/tests/routes/.gitkeep
    - apps/api/tests/docs/.gitkeep
    - tests/e2e/m2m/.gitkeep
    - tests/e2e/browser/.gitkeep
  modified:
    - packages/db/src/schema/api-keys.ts
    - packages/db/drizzle/meta/_journal.json
    - packages/core-types/src/errors/codes.ts
    - packages/core-types/src/errors/codes.test.ts
    - config/rate-limits.yaml
decisions:
  - supersedes column declared as plain uuid() without .references() in TS; self-FK added via raw SQL in migration (Drizzle cannot cleanly self-reference inside pgTable definition)
  - RESOURCE_NOT_FOUND placed in RESOURCE.* domain near TENANT_NOT_FOUND; no TENANT_MISMATCH or CORS_CONFIG_INVALID added per RESEARCH.md guidance
  - tests/isolation/vitest.config.ts mirrors tests/contract/vitest.config.ts exactly, adding @spatula/queue alias for SSE isolation assertions
metrics:
  duration: "~3 minutes"
  completed: "2026-05-20"
  tasks_completed: 3
  files_created: 9
  files_modified: 5
---

# Phase 17 Plan 01: Foundation Scaffolding Summary

**One-liner:** Drizzle migration adding api_keys rotation columns, additive RESOURCE.NOT_FOUND error code mapped to 404, Phase 17 rate-limit config entries, and test directory scaffolds for downstream plans.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add supersedes columns to api_keys via Drizzle migration | 048330c | 0001_api_key_rotation.sql, api-keys.ts, _journal.json, 0001_snapshot.json |
| 2 | Add RESOURCE_NOT_FOUND error code to frozen ErrorCode enum | b17af90 | codes.ts, codes.test.ts |
| 3 | Add rate-limit entries and scaffold Phase 17 test directories | 295e275 | rate-limits.yaml, tests/isolation/vitest.config.ts, 7x .gitkeep |

## Verification Evidence

- `cd packages/db && pnpm build` exits 0 — schema TS with new columns compiles
- `pnpm --filter @spatula/core-types test` exits 0 — 14 tests pass (11 original + 3 new RESOURCE_NOT_FOUND tests)
- `grep -q "jobs/{id}/events" config/rate-limits.yaml` passes
- `grep -q "api-keys/{id}/rotate" config/rate-limits.yaml` passes
- `test -f tests/isolation/vitest.config.ts` passes
- `test -f apps/api/tests/sse/.gitkeep` passes
- YAML parses valid: python3 yaml.safe_load confirms both route keys present

## Decisions Made

1. **Self-FK via raw SQL**: Drizzle's `pgTable` cannot reference a table within its own definition cleanly without circular-reference issues. The `supersedes` column is declared as `uuid('supersedes')` in TS (no `.references()`) and the FK constraint is applied directly in the migration SQL. The Drizzle snapshot JSON reflects this correctly.

2. **RESOURCE.* domain placement**: `RESOURCE_NOT_FOUND: 'RESOURCE.NOT_FOUND'` placed after existing domain sections, before `TENANT.*`. This follows RESEARCH.md Open Question 2's recommendation — cross-tenant access returns 404 with this code (D-18 "prefer 404" policy). No `TENANT_MISMATCH` or `CORS_CONFIG_INVALID` added.

3. **Isolation vitest config mirrors contract config**: `tests/isolation/vitest.config.ts` is a direct mirror of `tests/contract/vitest.config.ts` with the `include` glob changed to `tests/isolation/**/*.test.ts` and `@spatula/queue` already present in both aliases (contracts config already had it).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this is a pure foundation/scaffolding plan with no UI-rendering data flows.

## Self-Check: PASSED

- `packages/db/drizzle/0001_api_key_rotation.sql` — FOUND
- `packages/db/drizzle/meta/0001_snapshot.json` — FOUND
- `packages/db/src/schema/api-keys.ts` — FOUND (contains supersedes + supersededExpiresAt)
- `packages/core-types/src/errors/codes.ts` — FOUND (contains RESOURCE_NOT_FOUND)
- `config/rate-limits.yaml` — FOUND (contains both new route entries)
- `tests/isolation/vitest.config.ts` — FOUND
- Commits 048330c, b17af90, 295e275 — all verified in git log
