import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './drizzle',
  // Namespaced migration journal table per carve-out spec §3.1.3: keeps the OSS
  // migration history isolated from any future SaaS-side Drizzle journal that
  // shares the same Postgres instance. Both the programmatic migrate() call
  // (src/migrate.ts) and the standalone run-migrate.ts script must pass the
  // matching `migrationsTable` so the tracking row lands in the right table.
  migrationsTable: '__drizzle_migrations_oss',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/spatula',
  },
});
