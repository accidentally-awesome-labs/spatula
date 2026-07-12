# Backup & Restore Runbook

Authoritative backup and restore procedure for Spatula OSS.

This runbook covers Postgres (source of truth), the content store, and Redis (BullMQ queue state). It documents the exact `pg_dump` command, restore procedure, time-to-restore estimates, and verification steps. The round-trip behavior described here is exercised by `tests/e2e/backup/round-trip.test.ts`.

---

## What to Back Up

### Postgres (source of truth)

Postgres is the **only** durable store for Spatula data. All tenant, job, entity, extraction, API key, audit, and schema data lives here. Back it up first and always.

The OSS schema is managed under the `__drizzle_migrations_oss` journal. The migration journal itself is part of the database and is captured by `pg_dump`.

### Content Store

The content store holds raw-crawled HTML/text and export artifacts. Where it lives depends on the backend:

- **Postgres-backed store (default):** The `content_store` table is part of the Postgres database. It is fully included in the `pg_dump` — no separate content-store backup step is needed. To enumerate content-store keys independently (for a separate content-store export or parity check), query:

  ```sql
  SELECT key, content FROM content_store;
  ```

  This is the same enumeration the `tests/e2e/backup/round-trip.test.ts` uses to verify parity.

- **S3-backed store:** Content lives in an S3-compatible bucket, outside Postgres. Use your provider's native bucket replication or versioning tooling (AWS S3 Cross-Region Replication, R2 bucket replication, etc.). This is out of first-party scope for v1; Spatula's backup tooling covers Postgres only.

- **Local filesystem store (dev/test):** Files on disk. Standard filesystem backup applies. Not recommended for production.

### Redis (BullMQ queue state)

**Redis is reconcilable, not a source of truth. Do not treat Redis as authoritative for durable data.**

- All durable job and entity state is in Postgres.
- Redis holds BullMQ queue state: job entries waiting or processing, ws-token records, and rate-limit counters.
- Jobs in-flight or queued in Redis at backup time will be replayed on restart. BullMQ consumers are designed to be idempotent — processing a job twice is safe.
- Consequence: you do NOT need to back up Redis for a reliable disaster recovery. On restore, bring up the API and worker; any jobs that were in-flight will be re-enqueued from Postgres state on startup.

If your operations team requires Redis persistence for other reasons (e.g. point-in-time queue snapshot), configure Redis AOF/RDB persistence separately. That is beyond the scope of this runbook.

---

## Backup Procedure

### Prerequisites

- `pg_dump` 14+ installed on the backup host
- `PGPASSWORD` environment variable set, or a `.pgpass` file configured
- Sufficient disk space for the dump (estimate: 3–5× the live DB size as a buffer)

### Step 1: pg_dump

```bash
pg_dump \
  -h "$DB_HOST" \
  -p "${DB_PORT:-5432}" \
  -U "$DB_USER" \
  --no-owner \
  --no-acl \
  -f "spatula_$(date +%Y%m%d_%H%M%S).dump" \
  "$DB_NAME"
```

- `--no-owner`: omits ownership commands so the dump can restore as any superuser without `ALTER OWNER` errors.
- `--no-acl`: omits GRANT/REVOKE statements; re-apply access grants after restore if needed.
- The dump file is plain-text SQL (default format). Use `-Fc` for the custom format if you want parallel restore with `pg_restore -j`.

**pg_dump 14+ `\restrict` / `\unrestrict` tokens:** pg_dump 14+ may emit psql metacommands (`\restrict`, `\unrestrict`) as random tokens in the output. These are harmless for `psql` restore but can confuse schema-diff tooling. `scripts/normalize-schema-dump.sh` strips these when maintainers need deterministic schema comparisons. No action is needed for a standard restore.

**For Postgres-backed content store:** The `content_store` table travels with the pg_dump. No separate step required.

**For S3-backed content store:** Run your S3 bucket snapshot/replication before or after the pg_dump. Note the timestamp of both snapshots for consistency — there is no distributed snapshot across Postgres + S3 in v1. The window of inconsistency is the time between the two snapshots.

### Step 2: Verify the dump file

```bash
# Verify the dump file is readable and non-empty
wc -c spatula_<timestamp>.dump
head -5 spatula_<timestamp>.dump   # should start with "-- PostgreSQL database dump"

# For plain-text format, a quick sanity check:
grep -c "^COPY " spatula_<timestamp>.dump
# — should be > 0 if the DB has data
```

### Step 3: Store the dump

Move the dump file to durable storage (S3, GCS, a separate server) before proceeding. A local copy on the same host as the database is not a backup.

---

## Restore Procedure

### Prerequisites

- A fresh, empty Postgres database (or a database to be wiped and re-created)
- `psql` 14+ installed on the restore host
- The dump file from the backup step

### Step 1: Create a fresh database

```bash
# As a Postgres superuser:
createdb -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_SUPERUSER" "$DB_NAME"

# Or via psql:
psql -h "$DB_HOST" -U "$DB_SUPERUSER" -c "CREATE DATABASE $DB_NAME;"
```

If restoring over an existing database, drop and recreate first:

```bash
psql -h "$DB_HOST" -U "$DB_SUPERUSER" -c "DROP DATABASE IF EXISTS $DB_NAME;"
psql -h "$DB_HOST" -U "$DB_SUPERUSER" -c "CREATE DATABASE $DB_NAME;"
```

**Warning:** `DROP DATABASE` is irreversible. Confirm you are targeting the correct host and database name before running it.

### Step 2: Restore the dump

```bash
psql \
  -h "$DB_HOST" \
  -p "${DB_PORT:-5432}" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -f spatula_<timestamp>.dump
```

For custom-format dumps (`pg_dump -Fc`), use `pg_restore` with parallel jobs:

```bash
pg_restore \
  -h "$DB_HOST" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -j 4 \
  --no-owner --no-acl \
  spatula_<timestamp>.dump
```

### Step 3: Verify row counts and content-store parity

These steps mirror the checks in `tests/e2e/backup/round-trip.test.ts`:

```sql
-- Row count parity per key table (compare against pre-dump counts if available)
SELECT 'tenants' AS tbl, COUNT(*) FROM tenants
UNION ALL SELECT 'jobs', COUNT(*) FROM jobs
UNION ALL SELECT 'entities', COUNT(*) FROM entities
UNION ALL SELECT 'content_store', COUNT(*) FROM content_store
UNION ALL SELECT 'api_keys', COUNT(*) FROM api_keys;

-- Content-store spot check: verify a known key's content
SELECT key, LENGTH(content) AS content_len
FROM content_store
WHERE key LIKE '<your-key-prefix>/%'
LIMIT 10;

-- Confirm migration journal is intact
SELECT id, created_at FROM drizzle.__drizzle_migrations_oss ORDER BY created_at;
```

### Step 4: Run spatula doctor

```bash
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST/$DB_NAME" \
  spatula doctor
```

All 9 checks should be green after a successful restore (assuming Redis and API are also running). Pay particular attention to the `migrations` check — it confirms Drizzle's migration journal matches the applied schema.

---

## Time-to-Restore Estimates

These estimates assume a **single-server restore** (psql piped from a local dump file on the same network as Postgres). Actual times depend on disk I/O speed, network latency, Postgres server capacity, and dump format (plain-text vs custom). **Measure on your hardware before committing to an RTO.**

| Database Size | Estimated Restore Time | Notes                                                             |
| ------------- | ---------------------- | ----------------------------------------------------------------- |
| < 1 GB        | 1–5 minutes            | Plain-text `psql` restore; single-threaded                        |
| 1–10 GB       | 5–30 minutes           | Plain-text; I/O bound; consider custom format + `pg_restore -j 4` |
| 10–100 GB     | 30–120 minutes         | Custom format + parallel restore strongly recommended             |
| > 100 GB      | > 2 hours              | Parallel restore + tablespace layout + WAL tuning needed          |

**Methodology note:** These are order-of-magnitude estimates based on typical cloud VM I/O (IOPS ~3000, sequential write ~250 MB/s). To measure your own baseline:

```bash
# Time a dry-run restore into a temporary scratch database
time psql -h "$DB_HOST" -U "$DB_USER" -d "$SCRATCH_DB" -f spatula_<timestamp>.dump
```

Run this once on your target infrastructure with a representative dump and record the result in your ops runbook. Update your SLA accordingly.

---

## Verification Checklist

After a restore, confirm all of the following before routing production traffic to the restored database:

- [ ] `spatula doctor` returns all 9 checks green
- [ ] Row count parity: `SELECT COUNT(*) FROM tenants/jobs/entities/content_store` matches the pre-dump counts (or an acceptable delta if some writes occurred during backup)
- [ ] Content-hash spot check: at least 5 random `content_store` rows have correct content (no truncation, no encoding corruption)
- [ ] Migration journal intact: `SELECT COUNT(*) FROM drizzle.__drizzle_migrations_oss` matches the expected number of applied migrations
- [ ] API starts cleanly and `GET /health/ready` returns 200
- [ ] A sample read query succeeds: `GET /api/v1/jobs` returns the expected list

---

## Related Resources

- `docs/runbooks/upgrade.md` — no-migration-downgrade policy + expand-contract rule; the pre-flight pg_dump step is the same one described here
- `docs/runbooks/upgrade.md#version-to-version-migration-template` — version migration pre-flight uses this backup procedure
- `tests/e2e/backup/round-trip.test.ts` — automated round-trip test that exercises pg_dump + restore + row-count + content-hash parity

---

_Phase: 19-deployment-self-host-excellence_
_Authored: 2026-06-10 (Plan 19-08)_
