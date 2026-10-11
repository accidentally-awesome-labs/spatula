import { fileURLToPath } from 'node:url';
import { TransactionRollbackError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Database, Executor } from './client';
import { databaseUrl, isLocalDatabase } from './env';

/** The URL of the database `name` on the same server as the development database. */
function testDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

/** A test database's name: plain enough to quote as an identifier, and saying what it's for. */
const TEST_DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/u;

/**
 * Drops the database `name` next to the development database, recreates it from the migrations,
 * and returns its URL. Refuses servers that aren't local unless ALLOW_DB_RESET=1 is set, and any
 * name but lowercase letters, digits, and underscores ending in `_test`.
 */
export async function prepareTestDatabase(name: string): Promise<string> {
  // The locality check reads only the host name, so another server on this machine passes it.
  // The name is what keeps a drop from reaching a database that isn't for tests.
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} isn’t a test database’s name: use lowercase letters, digits, and underscores, ending in _test.`,
    );
  }
  const server = databaseUrl();
  if (!isLocalDatabase(server) && process.env.ALLOW_DB_RESET !== '1') {
    throw new Error(
      `The tests recreate ${name} next to ${new URL(server).host}, which isn’t local. Set ALLOW_DB_RESET=1 to allow it.`,
    );
  }
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = testDatabaseUrl(name);
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await client.end();
  }
  return url;
}

/** Runs each test in a transaction that's always rolled back, so every test starts from the migrations. */
export function rollbackRunner(db: Database) {
  return async function withRollback(fn: (tx: Executor) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  };
}
