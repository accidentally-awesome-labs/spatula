import { pgTable, uuid, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { rawPages } from './raw-pages.js';
import { tenants } from './tenants.js';

export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    pageId: uuid('page_id')
      .notNull()
      .references(() => rawPages.id),
    schemaVersion: integer('schema_version').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    unmappedFields: jsonb('unmapped_fields').$type<unknown[]>().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('extractions_job_schema_idx').on(table.jobId, table.schemaVersion),
    index('extractions_page_idx').on(table.pageId),
    index('idx_extractions_job').on(table.jobId, table.tenantId),
    index('idx_extractions_updated').on(table.updatedAt),
  ],
);
