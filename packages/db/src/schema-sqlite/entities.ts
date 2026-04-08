/**
 * SQLite entities + entity_sources tables — mirrors Postgres with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - CHANGE: categories is text (JSON array string) instead of text[]
 * - ADD: sourceCount, updatedAt (local extensions)
 */
import { sqliteTable, text, real, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    mergedData: text('merged_data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    provenance: text('provenance', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    // JSON-encoded array (Postgres uses text[]; Drizzle auto-serializes via json mode)
    categories: text('categories', { mode: 'json' }).notNull().default([]),
    qualityScore: real('quality_score').notNull().default(0),
    createdAt: text('created_at').notNull(),
    // Local extensions
    sourceCount: integer('source_count').default(0),
    updatedAt: text('updated_at'),
    runId: text('run_id'),
  },
  (table) => [
    index('sl_entities_job_quality_idx').on(table.jobId, table.qualityScore),
    index('sl_entities_run_id_idx').on(table.runId),
  ],
);

export const entitySources = sqliteTable(
  'entity_sources',
  {
    entityId: text('entity_id').notNull(),
    extractionId: text('extraction_id').notNull(),
    matchConfidence: real('match_confidence').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entityId, table.extractionId] })],
);
