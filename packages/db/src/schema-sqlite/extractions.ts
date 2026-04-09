/**
 * SQLite extractions table — mirrors Postgres with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const extractions = sqliteTable(
  'extractions',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    pageId: text('page_id'),  // nullable for remote-pulled records
    schemaVersion: integer('schema_version').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    unmappedFields: text('unmapped_fields', { mode: 'json' })
      .$type<Record<string, unknown>[]>()
      .default([]),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    runId: text('run_id'),
    pageUrl: text('page_url'),
  },
  (table) => [
    index('sl_extractions_job_schema_idx').on(table.jobId, table.schemaVersion),
    index('sl_extractions_page_idx').on(table.pageId),
    index('sl_extractions_run_id_idx').on(table.runId),
  ],
);
