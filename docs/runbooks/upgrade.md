# Upgrade Runbook

Authoritative upgrade procedures and schema-change policies for Spatula OSS.

Related runbooks: `backup-restore.md`, `reverse-proxy.md`, `hardware-sizing.md`, and `verify-images.md`.

---

## No-migration-downgrade policy

**Spatula migrations are forward-only.** There is no `down()` for any production migration. Once a release tag's migrations apply to a database, that database cannot roll back to a prior release without restoring from a backup.

**Operational implications:**

- Always back up Postgres before applying a new release's migrations.
- If a release goes bad, roll forward (publish a patch release with a corrective migration) or restore from backup. Never attempt to reverse a migration in place.
- Pre-flight: `pg_dump` the OSS schema + data BEFORE every `pnpm db:migrate` invocation in production.

Every PR that modifies migrations under `packages/db/drizzle/` should call out this policy in its description.

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

Releases that violate expand-contract MUST be tagged with a major-version bump (v2.x.x). The full SDK ↔ server ↔ core-types compat matrix and its enforcement live in `docs/compat-policy.md`.

---

## Migration journal

Spatula uses a dedicated Drizzle migration tracking table so its migration state is isolated from any other tools or schemas in the same database.

| Repository  | Migration journal table                          | Migration folder       |
| ----------- | ------------------------------------------------ | ---------------------- |
| Spatula OSS | `__drizzle_migrations_oss` (in `drizzle` schema) | `packages/db/drizzle/` |

The OSS journal name (`__drizzle_migrations_oss`) is pinned in three places that must stay in sync:

- `packages/db/drizzle.config.ts` — `drizzle-kit` config (under the `migrations.table` key)
- `packages/db/src/migrate.ts` — programmatic `migrate()` call (flat `migrationsTable` arg)
- `packages/db/src/run-migrate.ts` — standalone migration runner script

---

## Version-to-Version Migration Template

Use this template when upgrading Spatula from one release to the next. This section does **not** repeat the policies above — read the no-migration-downgrade and expand-contract sections before running any upgrade.

### Pre-flight

1. **Back up Postgres.** Run the full `pg_dump` backup per `docs/runbooks/backup-restore.md` **before** any migration command. Keep the dump file accessible until you have confirmed the upgrade is stable.

   ```bash
   pg_dump \
     -h "$DB_HOST" -U "$DB_USER" \
     --no-owner --no-acl \
     -f "spatula_preflight_$(date +%Y%m%d_%H%M%S).dump" \
     "$DB_NAME"
   ```

2. **Check the release notes** for the target version. Look for:
   - Any expand-phase migrations (additive columns or tables) that must land before a contract phase.
   - Any manual data-backfill steps called out in the release notes.
   - Any breaking changes that require a major-version bump (v2.x.x) — if present, plan a maintenance window.

### Apply Migrations

Run the Drizzle migration runner against your target database. The canonical migration entrypoint is `packages/db/dist/run-migrate.js` (built via `pnpm build`), exposed as the `migrate` container image:

```bash
# Via the migrate image (k8s Job or docker-compose one-shot):
docker run --rm \
  -e DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST/$DB_NAME" \
  ghcr.io/accidentally-awesome-labs/spatula/migrate:<version>

# Or locally (if running the monorepo directly):
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST/$DB_NAME" \
  pnpm --filter @accidentally-awesome-labs/spatula-db exec tsx src/run-migrate.ts
```

The migrator applies any migrations under `packages/db/drizzle/` that are not yet recorded in `drizzle.__drizzle_migrations_oss`. It is idempotent — running it twice is safe.

### Verify

1. Run `spatula doctor` and confirm all 9 checks are green, including the `migrations` check.

   ```bash
   DATABASE_URL="..." REDIS_URL="..." API_URL="http://localhost:3000" \
     spatula doctor
   ```

2. Run a smoke test against the upgraded API:

   ```bash
   curl -sf http://localhost:3000/health/ready   # → 200
   curl -sf http://localhost:3000/api/v1/openapi.json | jq '.info.version'  # → new version
   ```

3. Confirm no unexpected rows in error logs or the DLQ (`bull_board` or `GET /admin/dlq`).

### Rollback Path

**Migrations are forward-only** (no-migration-downgrade policy — see above). If the upgrade fails:

1. **Do NOT attempt to reverse a migration in place.**
2. Restore from the pre-flight dump:

   ```bash
   # Drop and recreate the database
   psql -U "$DB_SUPERUSER" -c "DROP DATABASE $DB_NAME;"
   psql -U "$DB_SUPERUSER" -c "CREATE DATABASE $DB_NAME;"
   # Restore
   psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f spatula_preflight_<timestamp>.dump
   ```

3. Re-deploy the previous version's container images.
4. File a bug report + open a patch release with a corrective migration if data was partially written.

See `docs/runbooks/backup-restore.md` for the full restore procedure and verification checklist.

---

_Last reviewed: 2026-07-12._
