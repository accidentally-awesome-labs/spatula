/**
 * SQLite runs table — local-only, no Postgres equivalent.
 * Tracks each invocation of `spatula run`.
 *
 * The `source` column distinguishes local runs from pulled data:
 * - 'local' for crawl runs
 * - 'remote:<name>:<jobId>' for pull operations
 */
import { sqliteTable, text, integer, real, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    source: text('source').notNull().default('local'),
    configSnapshot: text('config_snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    pagesCrawled: integer('pages_crawled').default(0),
    pagesReextracted: integer('pages_reextracted').default(0),
    entitiesCreated: integer('entities_created').default(0),
    llmTokensUsed: integer('llm_tokens_used').default(0),
    llmCostUsd: real('llm_cost_usd').default(0),
    errorMessage: text('error_message'),
  },
  (table) => [
    check('status_check', sql`${table.status} IN ('running','paused','completed','failed','pulled')`),
  ],
);
