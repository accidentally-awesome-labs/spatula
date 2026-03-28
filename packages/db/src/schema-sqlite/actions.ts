/**
 * SQLite actions table — mirrors Postgres actions with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - Enum columns use CHECK constraints instead of pgEnum
 */
import { sqliteTable, text, real, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const actions = sqliteTable(
  'actions',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending_review'),
    confidence: real('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    stateChanges: text('state_changes', { mode: 'json' }).$type<Record<string, unknown>>(),
    reviewedBy: text('reviewed_by'),
    createdAt: text('created_at').notNull(),
    appliedAt: text('applied_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('sl_actions_job_type_idx').on(table.jobId, table.type),
    index('sl_actions_job_status_idx').on(table.jobId, table.status),
    index('sl_actions_job_created_idx').on(table.jobId, table.createdAt),
    check(
      'source_check',
      sql`${table.source} IN ('extraction','schema_evolution','reconciliation','quality_audit')`,
    ),
    check(
      'status_check',
      sql`${table.status} IN ('pending_review','approved','applied','rejected','rolled_back')`,
    ),
  ],
);
