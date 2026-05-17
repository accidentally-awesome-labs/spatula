import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabasePool } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString?: string) {
  const { db, pool } = createDatabasePool(connectionString);
  // __dirname resolves to either src/ or dist/ depending on whether we're
  // running from source (tsx) or compiled output. In both cases the drizzle/
  // folder lives one level up from the containing directory (packages/db/).
  const pkgRoot = resolve(__dirname, '..');
  try {
    await migrate(db, {
      migrationsFolder: resolve(pkgRoot, 'drizzle'),
      migrationsTable: '__drizzle_migrations_oss',
    });
  } finally {
    await pool.end();
  }
}
