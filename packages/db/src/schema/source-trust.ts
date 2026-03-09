import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
import { trustLevelEnum } from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const sourceTrust = pgTable(
  'source_trust',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    domain: text('domain').notNull(),
    trustLevel: trustLevelEnum('trust_level').notNull(),
    reasoning: text('reasoning').notNull(),
  },
  (table) => [
    index('source_trust_job_domain_idx').on(table.jobId, table.domain),
    index('source_trust_tenant_idx').on(table.tenantId),
  ],
);
