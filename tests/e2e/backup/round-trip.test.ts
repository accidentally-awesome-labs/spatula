/**
 * Backup → restore round-trip e2e test (DEPLOY-05)
 *
 * Seeds rows across several tables + N content_store blobs, runs pg_dump,
 * restores into a fresh scratch DB, and asserts:
 *
 *  1. Row counts per seeded table match the originals
 *  2. Each content_store blob's SHA-256 content hash matches (parity)
 *
 * Gates on a real Postgres connection (skip if DATABASE_URL absent),
 * following the same pattern as the DSR deletion round-trip test.
 *
 * Scope: Postgres-backed ContentStore only. S3/Local stores use native
 * bucket replication tooling and are out of scope for v1 backup (see runbook).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';

import { createDatabase, PgContentStore } from '@spatula/db';
import type { Database } from '@spatula/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/spatula_test';

// Scratch DB name — will be dropped + recreated during the test
const SCRATCH_DB = 'spatula_backup_restore_test';

// Tables to seed + verify counts (tenant-scoped tables with straightforward rows)
const SEEDED_TABLES = ['jobs', 'api_keys', 'crawl_tasks'] as const;

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

let db: Database;
let setupOk = false;

beforeAll(async () => {
  try {
    db = createDatabase(DATABASE_URL);
    await db.execute(sql`SELECT 1`);
    setupOk = true;
  } catch (err) {
    console.warn(
      '[Backup round-trip e2e] Skipping — no database available:',
      (err as Error).message,
    );
  }
});

afterAll(async () => {
  if (db) {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse connection string into pg components for psql/pg_dump CLI invocations */
function parseConnectionString(url: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: u.username,
    password: u.password,
    database: u.pathname.slice(1), // strip leading /
  };
}

/** Execute a SQL string against a given database URL using psql */
function psqlExec(connectionUrl: string, sqlStr: string): void {
  const conn = parseConnectionString(connectionUrl);
  // -d conn.database is REQUIRED: without it psql connects to a DB named after
  // the user (e.g. "spatula"), which need not exist. The caller routes CREATE/DROP
  // DATABASE through the "postgres" maintenance DB via adminUrl.
  execFileSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-c', sqlStr],
    {
      env: { ...process.env, PGPASSWORD: conn.password },
      stdio: 'pipe',
    },
  );
}

/** Run psql with an SQL file (< file) against the scratch DB */
function psqlFile(connectionUrl: string, filePath: string): void {
  const conn = parseConnectionString(connectionUrl);
  // -d conn.database targets the scratch DB encoded in scratchUrl (see psqlExec note).
  execFileSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-f', filePath],
    {
      env: { ...process.env, PGPASSWORD: conn.password },
      stdio: 'pipe',
    },
  );
}

/** SHA-256 of a UTF-8 string — used for content-hash parity */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Backup → restore round-trip (DEPLOY-05)', () => {
  it('proves row-count + content-hash parity after pg_dump → restore', async (ctx) => {
    if (!setupOk) return ctx.skip();

    const tenantId = randomUUID();
    const conn = parseConnectionString(DATABASE_URL);

    // ── 1. Seed rows + content-store blobs ──────────────────────────────────

    // Seed a tenant row
    await db.execute(
      sql`INSERT INTO tenants (id, name, config, quotas, storage_bytes_used, created_at)
            VALUES (${tenantId}::uuid, ${'Backup E2E Tenant'}, ${'{}'}::jsonb,
                    ${'{}'}::jsonb, ${0}, NOW())`,
    );

    // Seed a job
    const jobId = randomUUID();
    await db.execute(
      sql`INSERT INTO jobs (id, tenant_id, name, description, config, status, stats, created_at)
            VALUES (${jobId}::uuid, ${tenantId}::uuid, ${'Backup E2E Job'}, ${'Backup test'},
                    ${'{"seedUrls":["https://example.com"]}'}::jsonb,
                    ${'completed'}::job_status,
                    ${'{}'}::jsonb, NOW())`,
    );

    // Seed an api_key
    await db.execute(
      sql`INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, name, scopes, created_at)
            VALUES (${randomUUID()}::uuid, ${tenantId}::uuid,
                    ${'hash_backup_test'}, ${'spat_bk'}, ${'backup-key'},
                    ${'{read}'}::text[], NOW())`,
    );

    // Seed a crawl_task
    await db.execute(
      sql`INSERT INTO crawl_tasks (id, job_id, tenant_id, url, depth, status, priority, created_at)
            VALUES (${randomUUID()}::uuid, ${jobId}::uuid, ${tenantId}::uuid,
                    ${'https://example.com'}, ${0}, ${'completed'}::crawl_task_status,
                    ${'medium'}::task_priority, NOW())`,
    );

    // Capture per-table row counts BEFORE dump
    const countsBefore: Record<string, number> = {};
    for (const table of SEEDED_TABLES) {
      const result = await db.execute(
        sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = '${tenantId}'::uuid`),
      );
      countsBefore[table] = Number((result.rows[0] as { n: string }).n);
    }

    // Seed content_store blobs via PgContentStore (no listKeys needed — enumerate table)
    const contentStore = new PgContentStore(db);
    const blobs: Array<{ ref: string; key: string; hash: string; content: string }> = [];
    for (let i = 0; i < 3; i++) {
      const key = `backup-test/${tenantId}/blob-${i}.txt`;
      const content = `Backup test blob ${i} — tenant ${tenantId} — ${randomUUID()}`;
      const ref = await contentStore.store(key, content);
      blobs.push({ ref, key, hash: sha256(content), content });
    }

    // Enumerate content_store via Drizzle (NO listKeys — RESEARCH note)
    // We use the key prefix to find only our blobs (avoid touching other test data)
    const contentStoreBefore = await db.execute(
      sql`SELECT key, content FROM content_store WHERE key LIKE ${'backup-test/' + tenantId + '/%'}`,
    );
    expect(contentStoreBefore.rows.length).toBe(3);

    // ── 2. pg_dump the test database ────────────────────────────────────────

    const dumpFile = `/tmp/spatula_backup_test_${Date.now()}.dump`;
    execFileSync(
      'pg_dump',
      [
        '-h',
        conn.host,
        '-p',
        conn.port,
        '-U',
        conn.user,
        '--no-owner',
        '--no-acl',
        '-f',
        dumpFile,
        conn.database,
      ],
      {
        env: { ...process.env, PGPASSWORD: conn.password },
        stdio: 'pipe',
      },
    );

    // ── 3. Create scratch DB + restore ──────────────────────────────────────

    // Connect to the default postgres DB (not spatula_test) to drop/create
    const adminUrl = DATABASE_URL.replace(`/${conn.database}`, '/postgres');

    // Drop scratch if it exists, then create
    try {
      psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    } catch {
      // ignore — scratch may not exist on first run
    }
    psqlExec(adminUrl, `CREATE DATABASE ${SCRATCH_DB}`);

    // Restore the dump into the scratch DB
    const scratchUrl = DATABASE_URL.replace(`/${conn.database}`, `/${SCRATCH_DB}`);
    psqlFile(scratchUrl, dumpFile);

    // ── 4. Connect to scratch DB + assert ───────────────────────────────────

    const scratchDb = createDatabase(scratchUrl);

    try {
      // Assert row counts per seeded table
      for (const table of SEEDED_TABLES) {
        const result = await scratchDb.execute(
          sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = '${tenantId}'::uuid`),
        );
        const countAfter = Number((result.rows[0] as { n: string }).n);
        expect(countAfter, `Row count mismatch in ${table}`).toBe(countsBefore[table]);
      }

      // Assert content-hash parity for each blob
      // Enumerate content_store rows in restored DB via Drizzle (no listKeys)
      const contentStoreAfter = await scratchDb.execute(
        sql`SELECT key, content FROM content_store
              WHERE key LIKE ${'backup-test/' + tenantId + '/%'}
              ORDER BY key`,
      );
      expect(contentStoreAfter.rows.length, 'All blobs must survive restore').toBe(3);

      for (const row of contentStoreAfter.rows as Array<{ key: string; content: string }>) {
        const originalBlob = blobs.find((b) => b.key === row.key);
        expect(originalBlob, `Original blob not found for key: ${row.key}`).toBeDefined();
        const restoredHash = sha256(row.content);
        expect(restoredHash, `Content-hash mismatch for key: ${row.key}`).toBe(originalBlob!.hash);
      }

      // Also verify via ContentStore.retrieve() for additional parity assurance
      const scratchContentStore = new PgContentStore(scratchDb);
      for (const blob of blobs) {
        const retrieved = await scratchContentStore.retrieve(blob.ref);
        const retrievedHash = sha256(retrieved);
        expect(retrievedHash, `retrieve() hash mismatch for ref: ${blob.ref}`).toBe(blob.hash);
      }
    } finally {
      await (scratchDb as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }

    // ── 5. Cleanup seeded rows from source DB ────────────────────────────────

    // Remove content_store blobs seeded in source DB
    for (const blob of blobs) {
      await contentStore.delete(blob.ref);
    }
    // Remove tenant + cascade (jobs, api_keys, crawl_tasks via tenant_id)
    await db.execute(sql`DELETE FROM crawl_tasks WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM jobs WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);

    // Drop scratch DB
    try {
      psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    } catch {
      // best-effort cleanup
    }

    // Remove temp dump file
    try {
      execFileSync('rm', ['-f', dumpFile]);
    } catch {
      // best-effort
    }
  }, 60_000); // 60s timeout for pg_dump + restore
});
