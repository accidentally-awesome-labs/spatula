# Upgrade Runbook

Authoritative upgrade procedures and schema-change policies for Spatula OSS.

Sister runbooks (`backup-restore.md`, `reverse-proxy.md`, `hardware-sizing.md`, `support-matrix.md`) ship in Phase 19 (Deployment & Self-Host Excellence). Additional runbooks (`secret-scan-audit.md`, `post-publish-smoke.md`, `user-journey-baseline.md`, `incident-response.md`) ship in Phase 22 (Launch Mechanics). This runbook covers only the v1.1 schema/migration policy commitments and the pre-Wave-6 dev-DB handling notice required for self-hosters upgrading past v1.1.

---

## No-migration-downgrade policy

**Spatula migrations are forward-only.** There is no `down()` for any production migration. Once a release tag's migrations apply to a database, that database cannot roll back to a prior release without restoring from a backup. This is the `no-migration-downgrade` policy committed in v1.1.

**Operational implications:**

- Always back up Postgres before applying a new release's migrations.
- If a release goes bad, roll forward (publish a patch release with a corrective migration) or restore from backup. Never attempt to reverse a migration in place.
- Pre-flight: `pg_dump` the OSS schema + data BEFORE every `pnpm db:migrate` invocation in production.

This policy was committed in v1.1, Phase 15 (see commit log on the `feat/wave-6-1-carveout` branch) and is referenced from every PR description that modifies migrations under `packages/db/drizzle/`.

---

## Expand-contract-only schema-change rule

All post-v1 schema changes follow the **expand-then-contract** pattern across at least two releases. Single-release breaking changes are not permitted under semver-minor or semver-patch — they require a major-version bump.

**The pattern:**

1. **Expand (release N):** Add the new column / table / index alongside the old one. New code reads/writes both old + new shapes; old code continues to work against the old shape.
2. **Backfill:** Migrate data from old to new shape; verify parity.
3. **Contract (release N+1, after backfill is complete):** Remove the old column / table / index. Drop the dual-write code path.

**Examples requiring expand-contract:**

- Renaming a column (add new, dual-write, backfill, drop old)
- Changing a column's type (add new-typed column, dual-write with cast, drop old)
- Splitting a table

**Examples that do NOT require expand-contract** (additive-only — single release OK):

- Adding a new nullable column
- Adding a new table
- Adding a new index (with `CONCURRENTLY` to avoid table lock)

Releases that violate expand-contract MUST be tagged with a major-version bump (v2.x.x). The full SDK ↔ server ↔ core-types compat matrix and its enforcement live in `docs/compat-policy.md` (Phase 16 deliverable).

---

## Pre-Wave-6 dev DB handling (one-time, for developers upgrading past v1.1)

The v1.1 carve-out (Phase 15) squashes the pre-Wave-6 migration history (`0000_previous_nova.sql` through `0011_young_boomer.sql`) into a single `0000_v1_baseline.sql`. Developer machines that had pre-Wave-6 dev DBs **cannot incrementally apply** this baseline — the historical `__drizzle_migrations` table still references the old per-step migration hashes.

**The required action: wipe and re-seed your dev DB.**

```bash
# 1. Drop the dev DB (assumes default name; adjust to your local).
dropdb spatula_dev

# 2. Recreate.
createdb spatula_dev

# 3. Apply the squashed baseline.
DATABASE_URL="postgresql://spatula:spatula@localhost:5432/spatula_dev" \
  pnpm --filter @spatula/db exec tsx src/run-migrate.ts

# 4. Re-seed any local test data (your usual script).
```

**Do NOT** attempt to "merge" old data into the new baseline. There is no migration path for pre-v1.1 dev DBs; this is a one-time wipe-and-reseed event.

For production self-hosters: this only affects you if you ran a pre-Wave-6 build of Spatula (none of which were public releases). The first public release tag will be `v1.0.0-rc.1` (cut in Phase 22), built atop the squashed baseline — so any production database that was first migrated against `v1.0.0-rc.1` or later is unaffected.

---

## Two-journal migration model

Spatula uses two separate Drizzle migration tracking tables:

| Repo | Migration journal table | Migration folder |
|------|-------------------------|------------------|
| OSS (this repo) | `__drizzle_migrations_oss` (in `drizzle` schema) | `packages/db/drizzle/` |
| Private spatula-saas | `__drizzle_migrations_saas` (in `drizzle` schema) | (its own `drizzle/` folder, separate filenames) |

Both can target the same Postgres instance — the journals don't collide because each has a distinct table name within the `drizzle` schema.

The OSS journal name (`__drizzle_migrations_oss`) is pinned in three places that must stay in sync:

- `packages/db/drizzle.config.ts` — `drizzle-kit` config (under the `migrations.table` key)
- `packages/db/src/migrate.ts` — programmatic `migrate()` call (flat `migrationsTable` arg)
- `packages/db/src/run-migrate.ts` — standalone migration runner script

The `__drizzle_migrations_saas` journal is documented here for reference but is not created or referenced anywhere in the OSS repo. The two journals are non-overlapping by design.

---

## Schema equivalence gate (Phase 15)

The carve-out PR (`feat/wave-6-1-carveout`) ships a `pg_dump --schema-only` equivalence gate in `.github/workflows/migration-equivalence.yml`. The gate runs on every PR push and proves that applying the old sequential migrations (`0000_previous_nova` through `0011_young_boomer`, retrieved from the PR base SHA via `git ls-tree`) produces a schema that — after the Wave-4 normalizer strips pg_dump 14+ `\restrict`/`\unrestrict` random tokens and journal-row noise — matches the squashed `0000_v1_baseline.sql` schema **plus** an exact, frozen, change-only delta committed at `scripts/migration-equivalence-expected-diff.txt` (the intentional billing-removal delta).

The gate's pass condition was reformulated during Plan 15-04 execution (see Plan 15-04 SUMMARY for the Rule-4 architectural reformulation rationale): the original "diff must be empty" condition was incompatible with Plan 15-03's intentional billing strip; "diff matches frozen fixture" preserves D-05's documented intent (detect accidental schema drift) while accommodating the actual carve-out reality.

This is one-time scaffolding for the squash PR. After the carve-out PR merges, the maintainer may either retain the gate as a permanent guard against silent baseline drift or retire it (per the D-05 retention-is-maintainer's-call decision).

---

## Future runbooks

- `backup-restore.md` — Phase 19
- `reverse-proxy.md` — Phase 19
- `hardware-sizing.md` — Phase 19
- `support-matrix.md` — Phase 19
- `secret-scan-audit.md` — Phase 22
- `post-publish-smoke.md` — Phase 22
- `user-journey-baseline.md` — Phase 22
- `incident-response.md` — Phase 22

---

*Phase: 15-carveout-migration-squash*
*Authored: 2026-05-17 (Plan 15-06)*
