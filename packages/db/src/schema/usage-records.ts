import { pgTable, uuid, varchar, bigint, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dimension: varchar('dimension', { length: 50 }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    reportedToStripe: boolean('reported_to_stripe').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_usage_tenant_period').on(table.tenantId, table.periodStart, table.dimension),
  ],
);
