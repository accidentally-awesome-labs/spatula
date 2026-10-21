import type {
  ActorRecord,
  AppliedChange,
  ContentSignals,
  Definition,
  EvalScores,
  Excluded,
  FieldValue,
  GateResult,
  Method,
  Outcome,
  Question,
  ReviewActionKind,
  ReviewSuggestion,
  RunStatus,
  RunSummary,
  SourceProbe,
  Taxonomy,
} from '@spatula/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
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

export const ITEM_STATUSES = ['live', 'gone', 'refused', 'excluded', 'irrelevant'] as const;
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
    /** When discovery last read all of the source's sitemaps, completely. */
    listedAt: time('listed_at'),
    /** Runs in a row that read nothing of the source and met a refusal (ADR 0006). */
    blockedRuns: integer('blocked_runs').notNull().default(0),
    /** When the third blocked run in a row refused the source; null while it's live. */
    refusedAt: time('refused_at'),
    /** When a run last probed the source while it was refused, and what the probe met. */
    lastProbeAt: time('last_probe_at'),
    lastProbe: text('last_probe').$type<SourceProbe>(),
    /**
     * The start of the run whose verdict was counted last, so a step that runs again, or an older
     * run that ends after a newer one, counts nothing.
     */
    countedAt: time('counted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.id] }),
    check('sources_blocked_runs', sql`${t.blockedRuns} >= 0`),
    check('sources_last_probe', sql`${t.lastProbe} in ('blocked', 'no answer')`),
  ],
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
    /**
     * The taxonomy key the page's decision was made under (ADR 0007): what of the taxonomy its
     * question covered. A taxonomy change that alters it asks the page again.
     */
    taxonomyKey: text('taxonomy_key'),
    lastOutcome: text('last_outcome').$type<Outcome>(),
    outcomeStreak: integer('outcome_streak').notNull().default(0),
    /**
     * When discovery last found the page in its source's sitemaps; null for a definition's own
     * pages.
     */
    listedAt: time('listed_at'),
    /** The page's lastmod in that read, when its source trusts lastmods. */
    listedLastmod: text('listed_lastmod'),
    /** The listed lastmod when the page was last read, so a page whose lastmod moved is due. */
    fetchedLastmod: text('fetched_lastmod'),
    /** When the page was last asked for, whatever came of it. */
    lastFetchedAt: time('last_fetched_at'),
    /** Complete reads of its source's sitemaps in a row that left it out. */
    missingStreak: integer('missing_streak').notNull().default(0),
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
    // A file is deleted only when no page holds it (ADR 0008).
    index('items_content').on(t.contentHash),
    check(
      'items_status',
      sql`${t.status} in ('live', 'gone', 'refused', 'excluded', 'irrelevant')`,
    ),
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

export const FETCH_KINDS = ['page', 'sitemap'] as const;
export type FetchKind = (typeof FETCH_KINDS)[number];

/** The fetch log: one row per fetch, with the policy decision, the outcome, and the cost. */
export const fetches = pgTable(
  'fetches',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** What was fetched: an item's page, or one of a source's sitemaps. */
    kind: text('kind').$type<FetchKind>().notNull().default('page'),
    itemId: text('item_id').references(() => items.id, { onDelete: 'cascade' }),
    /**
     * The source whose sitemap this was. It has no foreign key: sources are keyed by dataset and
     * ID, and are never deleted, only marked removed. A fetch goes with its run.
     */
    sourceId: text('source_id'),
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
    check('fetches_kind', sql`${t.kind} in ('page', 'sitemap')`),
    check(
      'fetches_subject',
      sql`(${t.kind} = 'page' and ${t.itemId} is not null) or (${t.kind} = 'sitemap' and ${t.itemId} is null and ${t.sourceId} is not null)`,
    ),
  ],
);

/**
 * The page archive (ADR 0008): a page as a fetch found it. Its body is kept gzipped in R2 under its
 * SHA-256, `pages/<content_hash>.gz`, and what Spatula read from it under `read_key`. A page read
 * again unchanged adds none, so a page's captures differ from one to the next. Captures are private
 * evidence: they never reach a snapshot.
 */
export const captures = pgTable(
  'captures',
  {
    /** `cp_` and 20 characters, from the fetch and the body, so a step that runs again keeps one. */
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    /**
     * The source the page belonged to when it was captured. Pages move between sources (ADR 0006),
     * and a purge takes what was captured under a source too. Like a sitemap fetch's source, it has
     * no foreign key: sources are keyed by dataset and ID, and are never deleted.
     */
    sourceId: text('source_id').notNull(),
    fetchId: text('fetch_id')
      .notNull()
      .references(() => fetches.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    finalUrl: text('final_url').notNull(),
    httpStatus: integer('http_status'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    fetchedAt: time('fetched_at').notNull(),
    /** The body's SHA-256 as it arrived, which names its file. */
    contentHash: text('content_hash').notNull(),
    /** The body's size as it arrived; null when the fetch brought no body (a 304). */
    bytes: integer('bytes'),
    /** The gzipped file's size; null when this capture stored no file of its own. */
    storedBytes: integer('stored_bytes'),
    /** The Content Signals the host's robots.txt gave for the fetch, which robots.txt allowed. */
    signals: jsonb('signals').$type<ContentSignals>(),
    /** Where what Spatula read from the page is kept, and the version that read it; null until then. */
    readKey: text('read_key'),
    reader: integer('reader'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('captures_item').on(t.itemId, t.fetchedAt),
    index('captures_dataset_source').on(t.datasetId, t.sourceId),
    index('captures_content').on(t.contentHash),
    index('captures_fetch').on(t.fetchId),
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
    /** The capture the value was first found in (ADR 0008); null before the archive, or once it's gone. */
    captureId: text('capture_id').references(() => captures.id, { onDelete: 'set null' }),
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
    index('statements_capture').on(t.captureId),
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

export const SNAPSHOT_STATES = ['published', 'held', 'superseded', 'discarded'] as const;
export type SnapshotState = (typeof SNAPSHOT_STATES)[number];

/** What a snapshot left out, and what the gates found. */
export interface SnapshotReport {
  excluded: Excluded[];
  gates?: GateResult;
}

/**
 * Snapshots: published ones, with a generation unique per dataset, and held ones, with none, which
 * wait for the owner. A held snapshot is published, superseded by a newer run's, or discarded. The
 * file lives in R2 under `key`.
 */
export const snapshots = pgTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    state: text('state').$type<SnapshotState>().notNull().default('published'),
    generation: integer('generation'),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** The definition revision the records came from; null for snapshots from before slice 1. */
    revision: integer('revision'),
    recordCount: integer('record_count').notNull(),
    /** The hash of the records alone, to tell whether anything changed since the last one. */
    recordsSha256: text('records_sha256').notNull(),
    key: text('key').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    heldReason: text('held_reason'),
    createdAt: time('created_at').notNull().defaultNow(),
    publishedAt: time('published_at'),
    report: jsonb('report').$type<SnapshotReport>().notNull(),
  },
  (t) => [
    uniqueIndex('snapshots_generation').on(t.datasetId, t.generation),
    index('snapshots_run').on(t.runId),
    index('snapshots_dataset_state').on(t.datasetId, t.state),
    check('snapshots_generation_positive', sql`${t.generation} > 0`),
    check('snapshots_state', sql`${t.state} in ('published', 'held', 'superseded', 'discarded')`),
    // A snapshot has a generation, and a publication time, exactly when it's published.
    check(
      'snapshots_published',
      sql`(${t.state} = 'published') = (${t.generation} is not null) and (${t.state} = 'published') = (${t.publishedAt} is not null)`,
    ),
  ],
);

export const DECISION_OUTCOMES = ['rule', 'accepted', 'escalated'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export const VERDICTS = ['same', 'edition', 'not_same', 'unsure'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const JUDGES = ['rule', 'llm', 'person', 'consumer'] as const;
export type Judge = (typeof JUDGES)[number];
export const REVIEW_KINDS = ['classify', 'match', 'publication'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const REVIEW_STATUSES = ['open', 'decided', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * What the decision cascade was asked, on what evidence, by which adapter, and what came of it.
 * A record is never rewritten, but a person's answer finalizes it, and a newer question about the
 * same subject supersedes it.
 */
export const decisionRecords = pgTable(
  'decision_records',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** What it was about: an item's ID, or an item's and an entity's joined by a bar. */
    subject: text('subject').notNull(),
    /** What makes two questions the same question. */
    subjectKey: text('subject_key').notNull(),
    state: jsonb('state').$type<unknown>().notNull(),
    stateHash: text('state_hash').notNull(),
    question: jsonb('question').$type<Question>().notNull(),
    criteriaVersion: integer('criteria_version').notNull(),
    /** The adapter and model that answered; null for a rule's answer or no adapter at all. */
    adapter: text('adapter'),
    probabilities: jsonb('probabilities').$type<Record<string, number>>().notNull(),
    evidence: text('evidence').notNull(),
    thresholds: jsonb('thresholds').$type<{ accept: number }>().notNull(),
    outcome: text('outcome').$type<DecisionOutcome>().notNull(),
    answer: text('answer'),
    /** A person's confirmation or correction. */
    finalAnswer: text('final_answer'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    decidedAt: time('decided_at').notNull(),
    finalizedAt: time('finalized_at'),
    supersededAt: time('superseded_at'),
  },
  (t) => [
    uniqueIndex('decision_records_current')
      .on(t.datasetId, t.subjectKey, t.stateHash, t.criteriaVersion)
      .where(sql`${t.supersededAt} is null`),
    index('decision_records_subject').on(t.datasetId, t.subject),
    check('decision_records_outcome', sql`${t.outcome} in ('rule', 'accepted', 'escalated')`),
  ],
);

/**
 * Whether a page and an entity describe the same product. "Same" joins them; "edition" joins them,
 * and the record lists the page as an edition (ADR 0003); "not the same" keeps them apart for good;
 * "unsure" waits for a person. A person's verdict outranks any other.
 */
export const judgements = pgTable(
  'judgements',
  {
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    verdict: text('verdict').$type<Verdict>().notNull(),
    who: text('who').$type<Judge>().notNull(),
    confidence: doublePrecision('confidence').notNull(),
    decisionId: text('decision_id').references(() => decisionRecords.id, { onDelete: 'set null' }),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.entityId] }),
    index('judgements_dataset').on(t.datasetId),
    index('judgements_entity').on(t.entityId),
    index('judgements_decision').on(t.decisionId),
    check('judgements_verdict', sql`${t.verdict} in ('same', 'edition', 'not_same', 'unsure')`),
    check('judgements_who', sql`${t.who} in ('rule', 'llm', 'person', 'consumer')`),
    check('judgements_confidence', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

/** A reviewer's answer that differs from a person's, kept for the owner to see (ruling 12). */
export interface ReviewFlag {
  actor: ActorRecord;
  /** What the reviewer answered: an option, or parts by ID. */
  answer: unknown;
  at: string;
}

/** Questions waiting for a person: at most one open per subject. */
export const reviewItems = pgTable(
  'review_items',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ReviewKind>().notNull(),
    subject: text('subject').notNull(),
    itemId: text('item_id').references(() => items.id, { onDelete: 'cascade' }),
    entityId: text('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    decisionId: text('decision_id').references(() => decisionRecords.id, { onDelete: 'set null' }),
    question: jsonb('question').$type<Question>().notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<ReviewStatus>().notNull().default('open'),
    answer: text('answer'),
    /** Who answered it (ADR 0009): the owner, or a consumer's reviewer. */
    answeredBy: jsonb('answered_by').$type<ActorRecord>(),
    /** What the person who answered added, in their words. */
    note: text('note'),
    /** When a reviewer's answer that differs from a person's sent it to the owner (ruling 12). */
    flaggedAt: time('flagged_at'),
    /** That answer, and who gave it. */
    flag: jsonb('flag').$type<ReviewFlag>(),
    /** The owner's suggested answer, which an answer with `suggestion: true` takes. */
    suggestion: jsonb('suggestion').$type<ReviewSuggestion>(),
    createdAt: time('created_at').notNull(),
    closedAt: time('closed_at'),
  },
  (t) => [
    uniqueIndex('review_items_open')
      .on(t.datasetId, t.kind, t.subject)
      .where(sql`${t.status} = 'open'`),
    index('review_items_dataset').on(t.datasetId, t.status),
    index('review_items_item').on(t.itemId),
    index('review_items_entity').on(t.entityId),
    index('review_items_decision').on(t.decisionId),
    check('review_items_kind', sql`${t.kind} in ('classify', 'match', 'publication')`),
    check('review_items_status', sql`${t.status} in ('open', 'decided', 'dismissed')`),
    check('review_items_flagged', sql`(${t.flaggedAt} is null) = (${t.flag} is null)`),
  ],
);

export const ACK_OUTCOMES = ['applied', 'refused'] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

/**
 * What consumers said about the snapshots they read, signed. One per consumer and generation: the
 * same body again is a repeat, and another body is refused.
 */
export const acknowledgments = pgTable(
  'acknowledgments',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    generation: integer('generation').notNull(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => snapshots.id, { onDelete: 'cascade' }),
    outcome: text('outcome').$type<AckOutcome>().notNull(),
    detail: text('detail'),
    counts: jsonb('counts').$type<Record<string, number>>(),
    sentAt: time('sent_at').notNull(),
    receivedAt: time('received_at').notNull(),
    /** The hash of the signed body, to tell a repeat from a different acknowledgment. */
    bodySha256: text('body_sha256').notNull(),
  },
  (t) => [
    uniqueIndex('acknowledgments_generation').on(t.datasetId, t.consumer, t.generation),
    index('acknowledgments_snapshot').on(t.snapshotId),
    check('acknowledgments_outcome', sql`${t.outcome} in ('applied', 'refused')`),
  ],
);

/** A dataset's scores against its golden set, kept so their history shows (learning loop 6). */
export const evals = pgTable(
  'evals',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    goldenVersion: integer('golden_version').notNull(),
    scores: jsonb('scores').$type<EvalScores>().notNull(),
    createdAt: time('created_at').notNull(),
  },
  (t) => [index('evals_dataset').on(t.datasetId, t.createdAt)],
);

/**
 * A dataset's taxonomy (ADR 0007), one row per version, each whole. Version 1 is the seed; each
 * change or batch of changes makes the next, with what it applied and who applied it. A version is
 * never rewritten: undoing one makes another.
 */
export const taxonomyVersions = pgTable(
  'taxonomy_versions',
  {
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    taxonomy: jsonb('taxonomy').$type<Taxonomy>().notNull(),
    /** The changes it applied, with what undoing each needs; empty for the seed. */
    changes: jsonb('changes').$type<AppliedChange[]>().notNull(),
    actor: jsonb('actor').$type<ActorRecord>().notNull(),
    /** Whether Spatula applied it on its own, with a kind's earned autonomy. */
    autonomous: boolean('autonomous').notNull().default(false),
    /** The proposal it applied. No foreign key: a version outlives any proposal row. */
    proposalId: text('proposal_id'),
    /** The version it undid. */
    undoes: integer('undoes'),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.version] }),
    check('taxonomy_versions_version', sql`${t.version} > 0`),
  ],
);

/**
 * The review log (ADR 0009): every write through the review API, and each change Spatula applies to
 * a taxonomy on its own (ruling 14), with who made it. A run's ordinary decisions stay in their
 * decision records. Rows are only ever added.
 */
export const reviewActions = pgTable(
  'review_actions',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    action: text('action').$type<ReviewActionKind>().notNull(),
    /** What it was about: a question, a proposal, a taxonomy version, or a kind of change. */
    subject: text('subject').notNull(),
    actor: jsonb('actor').$type<ActorRecord>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    at: time('at').notNull(),
  },
  (t) => [
    index('review_actions_dataset').on(t.datasetId, t.at),
    check(
      'review_actions_action',
      sql`${t.action} in ('answer', 'flag', 'suggest', 'accept', 'edit', 'reject', 'apply', 'undo', 'revoke')`,
    ),
  ],
);
