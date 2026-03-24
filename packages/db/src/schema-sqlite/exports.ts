/**
 * SQLite exports table — local-only, no Postgres equivalent.
 * Tracks generated export files.
 *
 * NOTE: This is NOT a mirror of the Postgres exports table — it has a
 * different shape (no status, no contentRef; has filePath, runId instead).
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const exports = sqliteTable('exports', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  format: text('format').notNull(),
  filePath: text('file_path').notNull(),
  entityCount: integer('entity_count'),
  fileSize: integer('file_size'),
  includeProvenance: integer('include_provenance', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
});
