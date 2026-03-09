import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { trustLevelEnum } from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const sourceTrust = pgTable('source_trust', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  domain: text('domain').notNull(),
  trustLevel: trustLevelEnum('trust_level').notNull(),
  reasoning: text('reasoning').notNull(),
});
