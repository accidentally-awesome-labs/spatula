import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './drizzle',
  // Namespaced migration journal table keeps Spatula's migration history
  // isolated from any other Drizzle users in the same database. drizzle-kit nests
  // this under `migrations.table`;
  // the runtime migrator (src/migrate.ts, run-migrate.ts) accepts the flat
  // `migrationsTable` key — both must stay in sync.
  migrations: {
    table: '__drizzle_migrations_oss',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/spatula',
  },
});
