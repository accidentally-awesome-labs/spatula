import { pgTable, uuid, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const exports = pgTable(
  'exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    format: text('format').notNull(),
    status: text('status').notNull().default('pending'),
    includeProvenance: boolean('include_provenance').notNull().default(false),
    entityCount: integer('entity_count'),
    contentRef: text('content_ref'),
    fileSize: integer('file_size'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('exports_job_idx').on(table.jobId),
    index('exports_tenant_idx').on(table.tenantId),
    index('idx_exports_job_tenant').on(table.jobId, table.tenantId),
    index('idx_exports_updated').on(table.updatedAt),
  ],
);
