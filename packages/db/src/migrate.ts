import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString?: string) {
  const db = createDatabase(connectionString);
  await migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
}
