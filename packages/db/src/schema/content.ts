import { pgTable, uuid, text, timestamp, customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array }>({
  dataType() { return 'bytea'; },
});

export const contentStore = pgTable('content_store', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  content: text('content'),  // nullable — text exports
  binaryContent: bytea('binary_content'),  // nullable — binary exports
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
// CHECK constraints: (content IS NOT NULL OR binary_content IS NOT NULL) AND NOT (content IS NOT NULL AND binary_content IS NOT NULL)
// Applied via migration SQL if Drizzle check() not available
