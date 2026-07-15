/**
 * SQLite schemas table — mirrors Postgres schemasTable with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - parentId is text (self-referential, enforced by PRAGMA foreign_keys)
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import type { SchemaDefinition } from '@accidentally-awesome-labs/spatula-core';

export const schemasTable = sqliteTable(
  'schemas',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    version: integer('version').notNull(),
    definition: text('definition', { mode: 'json' }).$type<SchemaDefinition>().notNull(),
    parentId: text('parent_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('sl_schemas_job_version_idx').on(table.jobId, table.version)],
);
