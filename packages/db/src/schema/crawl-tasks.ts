import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  crawlTaskStatusEnum,
  taskPriorityEnum,
  pageClassificationEnum,
  crawlerTypeEnum,
} from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const crawlTasks = pgTable(
  'crawl_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    url: text('url').notNull(),
    depth: integer('depth').notNull().default(0),
    status: crawlTaskStatusEnum('status').notNull().default('pending'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    classification: pageClassificationEnum('classification'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => crawlTasks.id),
    crawlerType: crawlerTypeEnum('crawler_type'),
    contentRef: text('content_ref'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    index('crawl_tasks_job_status_idx').on(table.jobId, table.status),
    index('crawl_tasks_job_depth_idx').on(table.jobId, table.depth),
    index('crawl_tasks_url_idx').on(table.url),
  ],
);
