import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { crawlTasks } from './crawl-tasks.js';
import { tenants } from './tenants.js';

export const rawPages = pgTable(
  'raw_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => crawlTasks.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    contentRef: text('content_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('raw_pages_task_idx').on(table.taskId),
    index('raw_pages_content_hash_idx').on(table.contentHash),
  ],
);
