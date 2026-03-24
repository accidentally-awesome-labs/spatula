/**
 * SQLite source_trust table — mirrors Postgres sourceTrust with intentional differences:
 *
 * - DROP: tenantId (not needed locally)
 * - DROP: reasoning (per spec section 5.3 — Postgres has reasoning NOT NULL)
 * - ADD: score REAL (per spec)
 * - ADD: createdAt TEXT (per spec)
 */
import { sqliteTable, text, real, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const sourceTrust = sqliteTable(
  'source_trust',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    domain: text('domain').notNull(),
    trustLevel: text('trust_level').notNull(),
    score: real('score'),
    createdAt: text('created_at'),
  },
  (table) => [
    index('sl_source_trust_job_domain_idx').on(table.jobId, table.domain),
    check('trust_level_check', sql`${table.trustLevel} IN ('authoritative','high','medium','low')`),
  ],
);
