import { drizzle } from 'drizzle-orm/node-postgres';
import { StorageError } from '@spatula/shared';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new StorageError(
      'DATABASE_URL is required — pass it directly or set the environment variable',
    );
  }

  return drizzle({
    connection: { connectionString: url },
    schema,
  });
}
