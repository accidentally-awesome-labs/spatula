import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const contentStore = pgTable('content_store', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
