/**
 * Upgrade migration test (DEPLOY-10)
 *
 * Proves the v1.0 → v1.x upgrade path works correctly:
 *  1. Creates a fresh scratch DB
 *  2. Applies 0000_v1_baseline.sql directly (simulates a v1.0 database)
 *  3. Runs runMigrations() (applies v1.x incremental migrations: 0001_api_key_rotation.sql)
 *  4. Asserts __drizzle_migrations_oss contains the expected applied migration rows
 *  5. Asserts SELECT 1 succeeds against each expected table (schema-level smoke)
 *
 * Approach note: We apply the baseline WITHOUT the __drizzle_migrations_oss journal
 * (i.e., psql < 0000_v1_baseline.sql directly), so the migrator sees the schema
 * tables as existing but has no journal records. runMigrations() will then:
 *   - detect the baseline tables are already there but journal is empty
 *   - attempt to apply all migrations (baseline + increments)
 *   - baseline may fail on existing tables (expected) or succeed in idempotent mode
 *
 * REALISTIC approach chosen: we apply the BASELINE via psql (schema only, no journal),
 * then run the migrator which will insert journal entries for any successfully applied
 * migrations. The migrator uses Drizzle's migrate() which checks __drizzle_migrations_oss
 * before applying each migration — so it will apply the increment (0001) even if the
 * baseline tables already exist (Drizzle catches the duplicate-table error from baseline
 * and marks it as applied). We verify the final state has both migration entries.
 *
 * Gates on a real Postgres connection (skip if DATABASE_URL absent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';

import { createDatabase, createDatabasePool, runMigrations } from '@spatula/db';
import type { Database } from '@spatula/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/spatula_test';

// Scratch DB for the upgrade test — isolated from the main test DB
const SCRATCH_DB = 'spatula_upgrade_test';

// Path to the drizzle migrations folder (relative to repo root)
const DRIZZLE_FOLDER = resolve(__dirname, '../../packages/db/drizzle');
const BASELINE_SQL = resolve(DRIZZLE_FOLDER, '0000_v1_baseline.sql');

// Tables expected to exist after baseline + upgrade (schema-level smoke)
const EXPECTED_TABLES = [
  'actions',
  'api_keys',
  'audit_log',
  'content_store',
  'crawl_tasks',
  'dead_letter_queue',
  'entities',
  'entity_sources',
  'exports',
  'extractions',
  'jobs',
  'llm_usage',
  'raw_pages',
  'schemas',
  'source_trust',
  'tenants',
];

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

let setupOk = false;

beforeAll(async () => {
  let checkDb: Database | null = null;
  try {
    checkDb = createDatabase(DATABASE_URL);
    await checkDb.execute(sql`SELECT 1`);
    setupOk = true;
  } catch (err) {
    console.warn(
      '[Upgrade migration e2e] Skipping — no database available:',
      (err as Error).message,
    );
  } finally {
    if (checkDb) {
      await (checkDb as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }
  }
});

afterAll(async () => {
  // Best-effort: drop scratch DB after all tests
  if (setupOk) {
    try {
      const conn = parseConnectionString(DATABASE_URL);
      const adminUrl = DATABASE_URL.replace(`/${conn.database}`, '/postgres');
      psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    } catch {
      // ignore cleanup errors
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    database: u.pathname.slice(1),
  };
}

function psqlExec(connectionUrl: string, sqlStr: string): void {
  const conn = parseConnectionString(connectionUrl);
  execFileSync('psql', ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-c', sqlStr], {
    env: { ...process.env, PGPASSWORD: conn.password },
    stdio: 'pipe',
  });
}

function psqlFile(connectionUrl: string, filePath: string): void {
  const conn = parseConnectionString(connectionUrl);
  execFileSync('psql', ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-f', filePath], {
    env: { ...process.env, PGPASSWORD: conn.password },
    stdio: 'pipe',
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('v1.0 → v1.x upgrade migration (DEPLOY-10)', () => {
  it('applies baseline SQL, runs migrator, and verifies __drizzle_migrations_oss + schema', async (ctx) => {
    if (!setupOk) return ctx.skip();

    const conn = parseConnectionString(DATABASE_URL);
    const adminUrl = DATABASE_URL.replace(`/${conn.database}`, '/postgres');
    const scratchUrl = DATABASE_URL.replace(`/${conn.database}`, `/${SCRATCH_DB}`);

    // ── 1. Create a fresh scratch DB ─────────────────────────────────────────
    psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    psqlExec(adminUrl, `CREATE DATABASE ${SCRATCH_DB}`);

    // ── 2. Apply 0000_v1_baseline.sql directly (simulates a v1.0 database) ──
    // This applies the schema WITHOUT the __drizzle_migrations_oss journal,
    // simulating a v1.0 database that was set up before Drizzle tracking existed.
    // The baseline SQL uses `CREATE TABLE` statements (not IF NOT EXISTS), so
    // applying it to a fresh DB creates all v1.0 tables cleanly.
    psqlFile(scratchUrl, BASELINE_SQL);

    // Verify baseline tables exist before running migrator
    const scratchDbCheck = createDatabase(scratchUrl);
    await scratchDbCheck.execute(sql`SELECT 1 FROM jobs LIMIT 0`);
    await (
      scratchDbCheck as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client?.end?.();

    // ── 3. Run the migrator against the scratch DB ────────────────────────────
    // runMigrations() applies all drizzle migrations in packages/db/drizzle/
    // tracking in __drizzle_migrations_oss.
    // With baseline tables already present (from step 2) and no journal,
    // Drizzle will try to apply the baseline again — the baseline CREATE TABLE
    // statements will fail with "already exists" on a fresh application.
    // To handle this realistically, we run the migrator with the scratch URL
    // and expect it to successfully apply at least the 0001 increment.
    //
    // Implementation: runMigrations() in @spatula/db wraps migrate() which
    // handles each migration in a transaction. If the baseline fails (table exists),
    // it rolls back that migration but records it as applied. The increment then
    // proceeds. We assert the final journal state.
    await runMigrations(scratchUrl);

    // ── 4. Connect to scratch DB and verify ──────────────────────────────────
    const { db: scratchDb, pool: scratchPool } = createDatabasePool(scratchUrl);

    try {
      // Assert __drizzle_migrations_oss contains both expected migration entries
      const migrationsResult = await scratchDb.execute(
        sql`SELECT hash, created_at FROM __drizzle_migrations_oss ORDER BY created_at ASC`,
      );
      const appliedHashes = (migrationsResult.rows as Array<{ hash: string }>).map((r) => r.hash);

      // Both the baseline and the increment must appear in the journal
      expect(
        appliedHashes.length,
        'Expected at least 2 applied migrations in __drizzle_migrations_oss',
      ).toBeGreaterThanOrEqual(2);

      // Assert schema-level smoke: SELECT 1 from each expected table
      for (const table of EXPECTED_TABLES) {
        await expect(
          scratchDb.execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 0`)),
        ).resolves.toBeDefined();
      }

      // Assert the v1.x-specific column from 0001_api_key_rotation.sql is present
      // (the `supersedes` column on api_keys)
      await expect(
        scratchDb.execute(sql`SELECT supersedes, superseded_expires_at FROM api_keys LIMIT 0`),
      ).resolves.toBeDefined();
    } finally {
      await scratchPool.end();
    }

    // ── 5. Cleanup: drop scratch DB ───────────────────────────────────────────
    psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  }, 60_000); // 60s timeout for DB operations
});
