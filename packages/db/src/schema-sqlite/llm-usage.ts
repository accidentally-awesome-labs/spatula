/**
 * SQLite llm_usage table — local-only, no Postgres equivalent.
 * Per-call LLM cost tracking.
 */
import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const llmUsage = sqliteTable(
  'llm_usage',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    purpose: text('purpose').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('sl_llm_usage_run_idx').on(table.runId),
    index('sl_llm_usage_created_idx').on(table.createdAt),
  ],
);
