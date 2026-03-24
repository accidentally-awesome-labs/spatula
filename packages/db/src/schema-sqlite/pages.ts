/**
 * SQLite pages table — mirrors Postgres raw_pages with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - ADD: url, statusCode, title, classification (merged from crawl_tasks for local query convenience)
 * - ADD: contentPath, needsReextraction, reextractionReason (local extensions)
 * - RENAME: Postgres raw_pages → SQLite pages
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const pages = sqliteTable(
  'pages',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    jobId: text('job_id').notNull(),
    contentRef: text('content_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    createdAt: text('created_at').notNull(),

    // Merged from crawl_tasks for local query convenience
    url: text('url'),
    statusCode: integer('status_code'),
    title: text('title'),
    classification: text('classification'),

    // Local extensions
    contentPath: text('content_path'),
    needsReextraction: integer('needs_reextraction', { mode: 'boolean' }).default(false),
    reextractionReason: text('reextraction_reason'),
  },
  (table) => [
    index('sl_pages_task_idx').on(table.taskId),
    index('sl_pages_content_hash_idx').on(table.contentHash),
    index('sl_pages_job_idx').on(table.jobId),
  ],
);
