/**
 * Upgrade migration test.
 *
 * Proves the v1.0 → v1.x upgrade path works correctly:
 *  1. Creates a fresh scratch DB
 *  2. Applies 0000_v1_baseline.sql directly (simulates a v1.0 database)
 *  3. Records the baseline migration in Drizzle's migration journal
 *  4. Runs runMigrations() (applies v1.x incremental migrations: 0001_api_key_rotation.sql)
 *  5. Asserts drizzle.__drizzle_migrations_oss contains the expected applied migration rows
 *  6. Asserts SELECT 1 succeeds against each expected table (schema-level smoke)
 *
 * Approach note: Drizzle decides which migrations to run exclusively from the
 * migration journal's latest created_at value. It does not infer that a baseline
 * schema is already present by catching duplicate table/type errors. This test
 * therefore applies the v1.0 schema and records the 0000 baseline journal row
 * before running the current migrator.
 *
 * Gates on a real Postgres connection (skip if DATABASE_URL absent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';

import {
  createDatabase,
  createDatabasePool,
  runMigrations,
} from '@accidentally-awesome-labs/spatula-db';
import type { Database } from '@accidentally-awesome-labs/spatula-db';

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
const API_KEY_ROTATION_SQL = resolve(DRIZZLE_FOLDER, '0001_api_key_rotation.sql');
const JOURNAL_JSON = resolve(DRIZZLE_FOLDER, 'meta/_journal.json');
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations_oss';
const MIGRATIONS_TABLE_REF = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

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
  // -d conn.database is required: without it psql connects to a database named
  // after the user instead of the database encoded in connectionUrl.
  execFileSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-c', sqlStr],
    {
      env: { ...process.env, PGPASSWORD: conn.password },
      stdio: 'pipe',
    },
  );
}

function psqlFile(connectionUrl: string, filePath: string): void {
  const conn = parseConnectionString(connectionUrl);
  execFileSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-f', filePath],
    {
      env: { ...process.env, PGPASSWORD: conn.password },
      stdio: 'pipe',
    },
  );
}

function migrationHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath, 'utf8')).digest('hex');
}

function migrationTimestamp(tag: string): number {
  const journal = JSON.parse(readFileSync(JOURNAL_JSON, 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const entry = journal.entries.find((candidate) => candidate.tag === tag);
  if (!entry) {
    throw new Error(`Migration journal entry not found: ${tag}`);
  }
  return entry.when;
}

async function recordBaselineMigration(db: Database): Promise<void> {
  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`));
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE_REF} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`),
  );
  await db.execute(
    sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE_REF)} ("hash", "created_at")
        VALUES (${migrationHash(BASELINE_SQL)}, ${migrationTimestamp('0000_v1_baseline')})`,
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('v1.0 -> v1.x upgrade migration', () => {
  it('applies baseline SQL, records baseline, runs migrator, and verifies schema', async (ctx) => {
    if (!setupOk) return ctx.skip();

    const conn = parseConnectionString(DATABASE_URL);
    const adminUrl = DATABASE_URL.replace(`/${conn.database}`, '/postgres');
    const scratchUrl = DATABASE_URL.replace(`/${conn.database}`, `/${SCRATCH_DB}`);

    // ── 1. Create a fresh scratch DB ─────────────────────────────────────────
    psqlExec(adminUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    psqlExec(adminUrl, `CREATE DATABASE ${SCRATCH_DB}`);

    // ── 2. Apply 0000_v1_baseline.sql directly (simulates a v1.0 database) ──
    psqlFile(scratchUrl, BASELINE_SQL);

    // Verify baseline tables exist, then mark the baseline migration as applied
    // so Drizzle will run only migrations newer than 0000_v1_baseline.
    const scratchDbCheck = createDatabase(scratchUrl);
    await scratchDbCheck.execute(sql`SELECT 1 FROM jobs LIMIT 0`);
    await recordBaselineMigration(scratchDbCheck);
    await (
      scratchDbCheck as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client?.end?.();

    // ── 3. Run the migrator against the scratch DB ────────────────────────────
    // runMigrations() applies all drizzle migrations in packages/db/drizzle/
    // tracking in drizzle.__drizzle_migrations_oss.
    await runMigrations(scratchUrl);

    // ── 4. Connect to scratch DB and verify ──────────────────────────────────
    const { db: scratchDb, pool: scratchPool } = createDatabasePool(scratchUrl);

    try {
      // Assert drizzle.__drizzle_migrations_oss contains both expected migration entries
      const migrationsResult = await scratchDb.execute(
        sql.raw(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE_REF} ORDER BY created_at ASC`),
      );
      const appliedHashes = (migrationsResult.rows as Array<{ hash: string }>).map((r) => r.hash);

      // Both the baseline and the increment must appear in the journal
      expect(appliedHashes).toEqual(
        expect.arrayContaining([migrationHash(BASELINE_SQL), migrationHash(API_KEY_ROTATION_SQL)]),
      );

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
