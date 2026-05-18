import { pgTable, uuid, text, jsonb, timestamp, bigint } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  quotas: jsonb('quotas').notNull().default({
    maxConcurrentJobs: 2,
    maxPagesPerJob: 5000,
    maxEntitiesPerExport: 50000,
    maxStorageMb: 1000,
  }),
  storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
