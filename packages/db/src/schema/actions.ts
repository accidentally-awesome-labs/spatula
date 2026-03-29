import { pgTable, uuid, text, jsonb, real, timestamp, index } from 'drizzle-orm/pg-core';
import { actionSourceEnum, actionStatusEnum } from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    source: actionSourceEnum('source').notNull(),
    status: actionStatusEnum('status').notNull().default('pending_review'),
    confidence: real('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    stateChanges: jsonb('state_changes').$type<Record<string, unknown>>(),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('actions_job_type_idx').on(table.jobId, table.type),
    index('actions_job_status_idx').on(table.jobId, table.status),
    index('actions_job_created_idx').on(table.jobId, table.createdAt),
    index('idx_actions_updated').on(table.updatedAt),
  ],
);
