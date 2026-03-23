import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { StorageError } from '@spatula/shared';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof drizzle>;
export type DatabasePool = { db: Database; pool: Pool };

/**
 * Create a pooled database connection. Returns both the Drizzle instance
 * and the underlying pg.Pool so shutdown handlers can call pool.end().
 */
export function createDatabasePool(connectionString?: string): DatabasePool {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new StorageError(
      'DATABASE_URL is required — pass it directly or set the environment variable',
    );
  }

  const pool = new Pool({
    connectionString: url,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

/**
 * Backward-compatible: returns only the Drizzle instance.
 * Prefer createDatabasePool() for new code that needs shutdown handling.
 */
export function createDatabase(connectionString?: string): Database {
  return createDatabasePool(connectionString).db;
}
