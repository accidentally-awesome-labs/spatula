import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { JobConfig } from '@spatula/core';
import { jobStatusEnum } from './enums.js';
import { tenants } from './tenants.js';
import { schemasTable } from './schemas.js';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    config: jsonb('config').$type<JobConfig>().notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    schemaId: uuid('schema_id').references((): AnyPgColumn => schemasTable.id),
    stats: jsonb('stats').$type<Record<string, number>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_tenant_status_idx').on(table.tenantId, table.status),
    index('jobs_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);
