import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { StorageError } from '@accidentally-awesome-labs/spatula-shared';
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

  const max = parseInt(process.env.DB_POOL_MAX || '20', 10);
  const idleTimeoutMillis = parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10);

  if (isNaN(max) || max < 1) {
    throw new StorageError('DB_POOL_MAX must be a positive integer');
  }
  if (isNaN(idleTimeoutMillis) || idleTimeoutMillis < 0) {
    throw new StorageError('DB_POOL_IDLE_TIMEOUT must be a non-negative integer');
  }

  const pool = new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    // Log but don't crash — pool will transparently reconnect on next query
    console.error('Unexpected database pool error:', err.message);
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
