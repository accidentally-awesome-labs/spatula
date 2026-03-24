/**
 * SQLite crawl_tasks table — mirrors Postgres crawlTasks with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - ADD: priorityScore, errorMessage, attempts, completedAt (local extensions)
 * - priority CHECK includes 'critical' (local extension, not in Postgres enum)
 * - Enum columns use CHECK constraints instead of pgEnum
 */
import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const crawlTasks = sqliteTable(
  'crawl_tasks',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    url: text('url').notNull(),
    depth: integer('depth').notNull().default(0),
    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('medium'),
    classification: text('classification'),
    parentTaskId: text('parent_task_id'),
    crawlerType: text('crawler_type'),
    contentRef: text('content_ref'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    createdAt: text('created_at').notNull(),
    processedAt: text('processed_at'),

    // Local extensions
    priorityScore: integer('priority_score'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').default(0),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('sqlite_crawl_tasks_job_status_idx').on(table.jobId, table.status),
    index('sqlite_crawl_tasks_job_depth_idx').on(table.jobId, table.depth),
    index('sqlite_crawl_tasks_url_idx').on(table.url),
    check('status_check', sql`${table.status} IN ('pending','in_progress','completed','failed','skipped')`),
    check('priority_check', sql`${table.priority} IN ('critical','high','medium','low')`),
    check('classification_check', sql`${table.classification} IN ('single_entry','multiple_entries','navigation','irrelevant','partial') OR ${table.classification} IS NULL`),
  ],
);
