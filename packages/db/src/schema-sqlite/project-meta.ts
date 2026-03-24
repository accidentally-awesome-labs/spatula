/**
 * SQLite project_meta table — local-only, no Postgres equivalent.
 * Simple key-value store for project state.
 *
 * Used for: project_id, schema_version, name, created_at,
 * remote job links, pull cursors.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projectMeta = sqliteTable('project_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
