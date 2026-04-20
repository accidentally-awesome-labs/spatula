/**
 * Vitest globalSetup — applies Drizzle migrations against TEST_DATABASE_URL
 * exactly once before any tests run in this package.
 *
 * Integration tests can then assume schema is current without each beforeAll
 * having to remember to call runMigrations().
 *
 * If TEST_DATABASE_URL is unset OR the DB is unreachable, we log a warning
 * and continue — unit tests that don't hit Postgres still pass, and
 * integration tests will fail loudly at their first query with a clear
 * connection error.
 */
import { runMigrations } from '../../src/migrate.js';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // No URL set → likely a unit-only run. Skip silently.
    return;
  }

  try {
    await runMigrations(url);
  } catch (err) {
    // Unreachable DB is not fatal at setup time. Integration tests that
    // actually need the DB will fail later with a connection error, which
    // is more informative than a setup-time stack trace.
    console.warn(
      `[globalSetup] Failed to apply migrations against ${url}: ${(err as Error).message}. ` +
        `Integration tests that rely on the schema may fail.`,
    );
  }
}
