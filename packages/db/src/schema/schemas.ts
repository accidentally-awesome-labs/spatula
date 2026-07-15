import { pgTable, uuid, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SchemaDefinition } from '@accidentally-awesome-labs/spatula-core';
import { tenants } from './tenants.js';
import { jobs } from './jobs.js';

export const schemasTable = pgTable(
  'schemas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references((): AnyPgColumn => jobs.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<SchemaDefinition>().notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => schemasTable.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('schemas_job_version_idx').on(table.jobId, table.version)],
);
