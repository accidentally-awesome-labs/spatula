import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './connection.js';

export async function runMigrations(connectionString?: string) {
  const db = createDatabase(connectionString);
  await migrate(db, { migrationsFolder: './drizzle' });
}
