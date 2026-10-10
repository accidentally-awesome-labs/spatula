import type {
  ContentSignals,
  Definition,
  Excluded,
  FieldValue,
  Method,
  Outcome,
  RunStatus,
  RunSummary,
} from '@spatula/core';
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * Spatula's system of record. Statements are never rewritten: a value seen again moves
 * `last_seen`, a changed value is a new statement, and one a source stops saying is withdrawn.
 * Entities keep the canonical IDs assigned to them, and `entity_keys` indexes their identity
 * claims. Every foreign key is indexed and states what a delete does. Deleting a dataset removes
 * everything under it, and nothing else is ever deleted.
 */

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const ITEM_STATUSES = ['live', 'gone', 'refused', 'excluded'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const datasets = pgTable(
  'datasets',
  {
    id: text('id').primaryKey(),
    revision: integer('revision').notNull(),
    definition: jsonb('definition').$type<Definition>().notNull(),
    definitionHash: text('definition_hash').notNull(),
    /** The latest published generation; it moves by compare-and-set. */
    headGeneration: integer('head_generation').notNull().default(0),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('datasets_revision_positive', sql`${t.revision} > 0`),
    check('datasets_head_generation_not_negative', sql`${t.headGeneration} >= 0`),
  ],
);

export const sources = pgTable(
  'sources',
  {
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    config: jsonb('config').$type<Definition['sources'][number]>().notNull(),
    removedAt: time('removed_at'),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.id] })],
);

export const entities = pgTable(
  'entities',
  {
    /** The canonical ID: `sp_` and 20 random characters, assigned once. */
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    status: text('status').$type<'active' | 'merged' | 'retired'>().notNull().default('active'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('entities_dataset').on(t.datasetId),
    check('entities_status', sql`${t.status} in ('active', 'merged', 'retired')`),
  ],
);

export const items = pgTable(
  'items',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    sourceId: text('source_id').notNull(),
    recordType: text('record_type').notNull(),
    /** The page's address, as the definition lists it. */
    locator: text('locator').notNull(),
    status: text('status').$type<ItemStatus>().notNull().default('live'),
    entityId: text('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    etag: text('etag'),
    lastModified: text('last_modified'),
    /** The SHA-256 of the latest page, which is also its key in R2. */
    contentHash: text('content_hash'),
    /** What the LLM was last asked, so an unchanged question isn't asked again. */
    extractInputHash: text('extract_input_hash'),
    /** The definition revision and extraction version the statements came from. */
    extractedWith: text('extracted_with'),
    lastOutcome: text('last_outcome').$type<Outcome>(),
    outcomeStreak: integer('outcome_streak').notNull().default(0),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'items_source_fk',
      columns: [t.datasetId, t.sourceId],
      foreignColumns: [sources.datasetId, sources.id],
    }).onDelete('cascade'),
    uniqueIndex('items_source_locator').on(t.datasetId, t.sourceId, t.locator),
    index('items_entity').on(t.entityId),
    check('items_status', sql`${t.status} in ('live', 'gone', 'refused', 'excluded')`),
  ],
);

export const runs = pgTable(
  'runs',
  {
    /** The Workflow instance's ID: the dataset and its five-minute slot. */
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    status: text('status').$type<RunStatus>().notNull(),
    startedAt: time('started_at').notNull().defaultNow(),
    finishedAt: time('finished_at'),
    summary: jsonb('summary').$type<RunSummary>(),
    error: text('error'),
  },
  (t) => [
    index('runs_dataset').on(t.datasetId, t.startedAt),
    check('runs_status', sql`${t.status} in ('running', 'complete', 'failed')`),
  ],
);

/** The fetch log: one row per fetch, with the policy decision, the outcome, and the cost. */
export const fetches = pgTable(
  'fetches',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    policy: text('policy').$type<'allowed' | 'denied'>().notNull(),
    policyReason: text('policy_reason'),
    method: text('method').notNull(),
    outcome: text('outcome').$type<Outcome>().notNull(),
    httpStatus: integer('http_status'),
    contentHash: text('content_hash'),
    bytes: integer('bytes'),
    /** The Content Signals robots.txt gave for this fetch. */
    signals: jsonb('signals').$type<ContentSignals>(),
    startedAt: time('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    /** What the LLM step did: ran, reused, skipped, or failed, with a reason. */
    llm: text('llm'),
    llmInputTokens: integer('llm_input_tokens').notNull().default(0),
    llmOutputTokens: integer('llm_output_tokens').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('fetches_run').on(t.runId),
    index('fetches_item').on(t.itemId, t.startedAt),
    check('fetches_policy', sql`${t.policy} in ('allowed', 'denied')`),
    check(
      'fetches_outcome',
      sql`${t.outcome} in ('changed', 'unchanged', 'gone', 'failed', 'blocked')`,
    ),
  ],
);

export const statements = pgTable(
  'statements',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    property: text('property').notNull(),
    value: jsonb('value').$type<FieldValue>().notNull(),
    valueKey: text('value_key').notNull(),
    original: text('original').notNull(),
    path: text('path').notNull(),
    method: text('method').$type<Method>().notNull(),
    confidence: doublePrecision('confidence').notNull(),
    position: integer('position'),
    /** The fetch that first found it, and the one that last did. */
    fetchId: text('fetch_id')
      .notNull()
      .references(() => fetches.id, { onDelete: 'no action' }),
    lastFetchId: text('last_fetch_id')
      .notNull()
      .references(() => fetches.id, { onDelete: 'no action' }),
    firstSeen: time('first_seen').notNull(),
    lastSeen: time('last_seen').notNull(),
    withdrawnAt: time('withdrawn_at'),
  },
  (t) => [
    // One current statement per item, property, method, and value.
    uniqueIndex('statements_current')
      .on(t.itemId, t.property, t.method, t.valueKey)
      .where(sql`${t.withdrawnAt} is null`),
    index('statements_item').on(t.itemId),
    index('statements_dataset').on(t.datasetId),
    index('statements_fetch').on(t.fetchId),
    index('statements_last_fetch').on(t.lastFetchId),
    check(
      'statements_method',
      sql`${t.method} in ('jsonld', 'microdata', 'opengraph', 'rule', 'llm', 'api', 'feed', 'human')`,
    ),
    check('statements_confidence', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

/** Identity claims, each owned by one entity, so an item finds its entity by its strongest claim. */
export const entityKeys = pgTable(
  'entity_keys',
  {
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.value] }),
    index('entity_keys_entity').on(t.entityId),
  ],
);

/** Published snapshots. The file lives in R2 under `key`; its generation is unique per dataset. */
export const snapshots = pgTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    recordCount: integer('record_count').notNull(),
    /** The hash of the records alone, to tell whether anything changed since the last one. */
    recordsSha256: text('records_sha256').notNull(),
    key: text('key').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    publishedAt: time('published_at').notNull(),
    report: jsonb('report').$type<{ excluded: Excluded[] }>().notNull(),
  },
  (t) => [
    uniqueIndex('snapshots_generation').on(t.datasetId, t.generation),
    index('snapshots_run').on(t.runId),
    check('snapshots_generation_positive', sql`${t.generation} > 0`),
  ],
);
