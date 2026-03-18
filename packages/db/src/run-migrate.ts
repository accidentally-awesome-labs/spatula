import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = createDatabase();
migrate(db, { migrationsFolder: resolve(__dirname, '../drizzle') })
  .then(() => {
    console.log('Migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
