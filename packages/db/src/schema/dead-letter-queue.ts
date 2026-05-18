import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { jobs } from './jobs.js';

export const deadLetterQueue = pgTable(
  'dead_letter_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueName: text('queue_name').notNull(),
    jobId: text('job_id').notNull(), // BullMQ job ID (string, not UUID)
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    spatulaJobId: uuid('spatula_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull(), // Full job data as JSONB (per spec 5.1.1)
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    attempts: integer('attempts').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'), // 'retried', 'discarded', 'fixed'
  },
  (table) => [
    index('dlq_queue_failed_idx').on(table.queueName, table.failedAt),
    index('dlq_tenant_idx').on(table.tenantId),
  ],
);
