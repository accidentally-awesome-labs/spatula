import {
  optionsOf,
  outcomeProbability,
  stableId,
  type ActorRecord,
  type Question,
  type ReviewSuggestion,
  type ReviewView,
} from '@spatula/core';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Executor } from './client';
import {
  decisionRecords,
  items,
  judgements,
  reviewItems,
  type DecisionOutcome,
  type Judge,
  type ReviewFlag,
  type ReviewKind,
  type ReviewStatus,
  type Verdict,
} from './schema';

/*
 * The decision cascade's memory (ADR 0003). A decision is found by what it was about, on what
 * evidence, under which criteria, so a question already answered is never asked again. A person's
 * verdict on a match outlasts any other, and each subject has at most one open review.
 */

export interface NewDecision {
  id: string;
  datasetId: string;
  type: string;
  subject: string;
  subjectKey: string;
  state: unknown;
  stateHash: string;
  question: Question;
  criteriaVersion: number;
  adapter: string | null;
  probabilities: Record<string, number>;
  evidence: string;
  thresholds: { accept: number };
  outcome: DecisionOutcome;
  answer: string | null;
  inputTokens: number;
  outputTokens: number;
  decidedAt: Date;
}

export interface DecisionRow extends NewDecision {
  finalAnswer: string | null;
  finalizedAt: Date | null;
}

const DECISION = {
  id: decisionRecords.id,
  datasetId: decisionRecords.datasetId,
  type: decisionRecords.type,
  subject: decisionRecords.subject,
  subjectKey: decisionRecords.subjectKey,
  state: decisionRecords.state,
  stateHash: decisionRecords.stateHash,
  question: decisionRecords.question,
  criteriaVersion: decisionRecords.criteriaVersion,
  adapter: decisionRecords.adapter,
  probabilities: decisionRecords.probabilities,
  evidence: decisionRecords.evidence,
  thresholds: decisionRecords.thresholds,
  outcome: decisionRecords.outcome,
  answer: decisionRecords.answer,
  inputTokens: decisionRecords.inputTokens,
  outputTokens: decisionRecords.outputTokens,
  decidedAt: decisionRecords.decidedAt,
  finalAnswer: decisionRecords.finalAnswer,
  finalizedAt: decisionRecords.finalizedAt,
};

/** The current decision about a subject on this evidence, under these criteria. */
export async function findDecision(
  db: Executor,
  key: { datasetId: string; subjectKey: string; stateHash: string; criteriaVersion: number },
): Promise<DecisionRow | null> {
  const [row] = await db
    .select(DECISION)
    .from(decisionRecords)
    .where(
      and(
        eq(decisionRecords.datasetId, key.datasetId),
        eq(decisionRecords.subjectKey, key.subjectKey),
        eq(decisionRecords.stateHash, key.stateHash),
        eq(decisionRecords.criteriaVersion, key.criteriaVersion),
        isNull(decisionRecords.supersededAt),
      ),
    );
  return row ?? null;
}

/** The decision with this ID while it's current: a step that runs again finds what it decided. */
export async function decisionById(db: Executor, id: string): Promise<DecisionRow | null> {
  const [row] = await db
    .select(DECISION)
    .from(decisionRecords)
    .where(and(eq(decisionRecords.id, id), isNull(decisionRecords.supersededAt)));
  return row ?? null;
}

/**
 * The subject's latest decision a person finalized, current or superseded: what a person last said
 * about it, whichever question they answered (ADR 0007). A newer question supersedes the one a
 * person answered, and what they said still carries over to it.
 */
export async function latestFinalized(
  db: Executor,
  input: { datasetId: string; subject: string },
): Promise<DecisionRow | null> {
  const [row] = await db
    .select(DECISION)
    .from(decisionRecords)
    .where(
      and(
        eq(decisionRecords.datasetId, input.datasetId),
        eq(decisionRecords.subject, input.subject),
        isNotNull(decisionRecords.finalizedAt),
      ),
    )
    .orderBy(desc(decisionRecords.finalizedAt), desc(decisionRecords.id))
    .limit(1);
  return row ?? null;
}

/**
 * A decision by its ID, current or superseded: the one a question was asked under, whatever was
 * decided about its subject since.
 */
export async function decisionWithId(db: Executor, id: string): Promise<DecisionRow | null> {
  const [row] = await db.select(DECISION).from(decisionRecords).where(eq(decisionRecords.id, id));
  return row ?? null;
}

/**
 * Records a decision, and retires the subject's earlier ones: the newest question about a subject
 * is its current one. A step that runs again gets back the record it saved the first time, even
 * when a newer question has retired it since, and retires nothing. Saves about one subject go one
 * at a time, so when two runs overlap, the later save retires the earlier one even if the earlier
 * hadn't committed when the later began.
 */
export async function saveDecision(db: Executor, decision: NewDecision): Promise<DecisionRow> {
  return db.transaction(async (tx) => {
    // Two saves under different IDs can't see each other's insert until it commits, so without
    // this lock each could retire nothing, and both would stay current. The lock is held until the
    // outermost transaction ends, whether this one is a savepoint in the caller's or not.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${decision.datasetId}::text || ':' || ${decision.subjectKey}::text, 0))`,
    );
    const [saved] = await tx
      .select(DECISION)
      .from(decisionRecords)
      .where(eq(decisionRecords.id, decision.id));
    if (saved !== undefined) return saved;
    await tx
      .update(decisionRecords)
      .set({ supersededAt: decision.decidedAt })
      .where(
        and(
          eq(decisionRecords.datasetId, decision.datasetId),
          eq(decisionRecords.subjectKey, decision.subjectKey),
          isNull(decisionRecords.supersededAt),
        ),
      );
    const [inserted] = await tx.insert(decisionRecords).values(decision).returning(DECISION);
    if (inserted === undefined) throw new Error(`Decision ${decision.id} could not be saved`);
    return inserted;
  });
}

/** A person's answer, which confirms or corrects the decision. */
export async function finalizeDecision(
  db: Executor,
  input: { id: string; finalAnswer: string; at: Date },
): Promise<void> {
  await db
    .update(decisionRecords)
    .set({ finalAnswer: input.finalAnswer, finalizedAt: input.at })
    .where(eq(decisionRecords.id, input.id));
}

/** Retires the current decisions about these subjects, so their questions can be asked again. */
export async function supersedeDecisions(
  db: Executor,
  input: { datasetId: string; subjects: string[]; at: Date },
): Promise<void> {
  if (input.subjects.length === 0) return;
  await db
    .update(decisionRecords)
    .set({ supersededAt: input.at })
    .where(
      and(
        eq(decisionRecords.datasetId, input.datasetId),
        inArray(decisionRecords.subject, input.subjects),
        isNull(decisionRecords.supersededAt),
      ),
    );
}

export interface JudgementRow {
  itemId: string;
  entityId: string;
  verdict: Verdict;
  who: Judge;
  confidence: number;
  decisionId: string | null;
}

/** Records a verdict on a page and an entity. Only a person replaces a person's verdict. */
export async function judge(
  db: Executor,
  input: JudgementRow & { datasetId: string; at: Date },
): Promise<void> {
  const { at, ...row } = input;
  await db
    .insert(judgements)
    .values({ ...row, updatedAt: at })
    .onConflictDoUpdate({
      target: [judgements.itemId, judgements.entityId],
      set: {
        verdict: sql`excluded.verdict`,
        who: sql`excluded.who`,
        confidence: sql`excluded.confidence`,
        decisionId: sql`excluded.decision_id`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`${judgements.who} <> 'person' or excluded.who = 'person'`,
    });
}

/**
 * The entities a page is judged to join, as the same product or an edition (ADR 0003), with who
 * judged each, by entity. A page joins one record, whichever verdict joins it.
 */
export async function sameVerdictsOf(
  db: Executor,
  itemId: string,
): Promise<{ entityId: string; who: Judge }[]> {
  return db
    .select({ entityId: judgements.entityId, who: judgements.who })
    .from(judgements)
    .where(and(eq(judgements.itemId, itemId), inArray(judgements.verdict, ['same', 'edition'])))
    .orderBy(asc(judgements.entityId));
}

/**
 * Holds back every other answer about the page's verdicts until this transaction ends, so two
 * answers about one page can't both pass a check of what was said about it.
 */
export async function lockPageVerdicts(db: Executor, itemId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('same:' || ${itemId}::text, 0))`,
  );
}

/** The entity the page is joined to, or null. */
export async function joinedEntityOf(db: Executor, itemId: string): Promise<string | null> {
  const [row] = await db
    .select({ entityId: items.entityId })
    .from(items)
    .where(eq(items.id, itemId));
  return row?.entityId ?? null;
}

/** Every verdict in the dataset. */
export async function judgementsFor(db: Executor, datasetId: string): Promise<JudgementRow[]> {
  return db
    .select({
      itemId: judgements.itemId,
      entityId: judgements.entityId,
      verdict: judgements.verdict,
      who: judgements.who,
      confidence: judgements.confidence,
      decisionId: judgements.decisionId,
    })
    .from(judgements)
    .where(eq(judgements.datasetId, datasetId))
    .orderBy(asc(judgements.itemId), asc(judgements.entityId));
}

export interface ReviewRow {
  id: string;
  datasetId: string;
  kind: ReviewKind;
  subject: string;
  itemId: string | null;
  entityId: string | null;
  decisionId: string | null;
  question: Question;
  context: Record<string, unknown>;
  status: ReviewStatus;
  answer: string | null;
  /** Who answered it; null before roles, and for a question nobody answered. */
  answeredBy: ActorRecord | null;
  note: string | null;
  /** When a reviewer's answer that differs from a person's sent it to the owner. */
  flaggedAt: Date | null;
  flag: ReviewFlag | null;
  /** The owner's suggested answer. */
  suggestion: ReviewSuggestion | null;
  createdAt: Date;
  closedAt: Date | null;
}

/**
 * Opens a question for a person, or updates the one already open about the same subject, and
 * returns the open question's ID. A step that runs again sends the ID it sent before, and gets it
 * back: a review with that ID that is closed by now stays as it is and nothing is written, so the
 * replay can neither open the question again nor write what it knew then over a newer question
 * about the subject.
 */
export async function openReview(
  db: Executor,
  input: {
    id: string;
    datasetId: string;
    kind: ReviewKind;
    subject: string;
    itemId?: string | null;
    entityId?: string | null;
    decisionId?: string | null;
    question: Question;
    context: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    // The lock keeps an answer from closing the review between this look and the write below, and
    // is the one the write takes, so two replays of one step wait for each other and can't deadlock.
    const [existing] = await tx
      .select({ status: reviewItems.status })
      .from(reviewItems)
      .where(eq(reviewItems.id, input.id))
      .for('no key update');
    if (existing !== undefined && existing.status !== 'open') return input.id;
    const [row] = await tx
      .insert(reviewItems)
      .values({
        id: input.id,
        datasetId: input.datasetId,
        kind: input.kind,
        subject: input.subject,
        itemId: input.itemId ?? null,
        entityId: input.entityId ?? null,
        decisionId: input.decisionId ?? null,
        question: input.question,
        context: input.context,
        createdAt: input.at,
      })
      .onConflictDoUpdate({
        target: [reviewItems.datasetId, reviewItems.kind, reviewItems.subject],
        targetWhere: sql`${reviewItems.status} = 'open'`,
        set: {
          question: sql`excluded.question`,
          context: sql`excluded.context`,
          decisionId: sql`excluded.decision_id`,
          itemId: sql`excluded.item_id`,
          entityId: sql`excluded.entity_id`,
        },
      })
      .returning({ id: reviewItems.id });
    if (row === undefined) throw new Error(`Review ${input.id} could not be opened`);
    return row.id;
  });
}

/** Which open questions a list shows. A filter left out lets every question through. */
export interface ReviewFilters {
  kind?: ReviewKind;
  /** A shelf's ID: the taxonomy questions that propose it, or have it settled. */
  shelf?: string;
  /** A source's ID: the questions about its pages. */
  source?: string;
  /**
   * The questions whose likeliest option has a probability below this: its outcome's, where options
   * share one (`topChance`).
   */
  below?: number;
  /** What a consumer's reviewers see (ruling 11): no flagged question, no publication one. */
  forConsumer?: boolean;
}

/**
 * The dataset's open questions, oldest first. A flag and a suggestion are listed only where there
 * is one, so a question has the shape it had before roles until something sets them. A consumer's
 * reviewers don't see the capture a question cites: captures are the owner's (ADR 0008).
 */
export async function listOpenReviews(
  db: Executor,
  datasetId: string,
  filters: ReviewFilters = {},
): Promise<ReviewView[]> {
  const consumer = filters.forConsumer === true;
  const rows = await db
    .select({
      id: reviewItems.id,
      kind: reviewItems.kind,
      subject: reviewItems.subject,
      question: reviewItems.question,
      context: reviewItems.context,
      createdAt: reviewItems.createdAt,
      flaggedAt: reviewItems.flaggedAt,
      suggestion: reviewItems.suggestion,
    })
    .from(reviewItems)
    .leftJoin(items, eq(items.id, reviewItems.itemId))
    .where(
      and(
        eq(reviewItems.datasetId, datasetId),
        eq(reviewItems.status, 'open'),
        filters.kind === undefined ? undefined : eq(reviewItems.kind, filters.kind),
        filters.source === undefined ? undefined : eq(items.sourceId, filters.source),
        consumer ? isNull(reviewItems.flaggedAt) : undefined,
        consumer ? ne(reviewItems.kind, 'publication') : undefined,
      ),
    )
    .orderBy(asc(reviewItems.createdAt), asc(reviewItems.id));
  const { shelf, below } = filters;
  return rows
    .filter((row) => shelf === undefined || onShelf(row.context, shelf))
    .filter((row) => {
      if (below === undefined) return true;
      const top = topChance(row.question, row.context);
      return top !== null && top < below;
    })
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      question: row.question,
      context: consumer ? withoutCapture(row.context) : row.context,
      createdAt: row.createdAt.toISOString(),
      ...(row.flaggedAt === null ? {} : { flagged: true as const }),
      ...(row.suggestion === null ? {} : { suggestion: row.suggestion }),
    }));
}

/** Whether a taxonomy question proposes the shelf, or has it settled. */
function onShelf(context: Record<string, unknown>, shelf: string): boolean {
  const shelfOf = (answer: unknown) =>
    typeof answer === 'object' && answer !== null
      ? (answer as Record<string, unknown>).shelf
      : undefined;
  return shelfOf(context.proposed) === shelf || shelfOf(context.settled) === shelf;
}

/**
 * How sure the decider was of a question's likeliest option, or null when no option has a
 * probability. Where the question groups its options into outcomes, as a match question does, the
 * likeliest option is measured by its outcome's total (`outcomeProbability`), as accepting it would
 * be (ADR 0003).
 */
function topChance(question: Question, context: Record<string, unknown>): number | null {
  const given = context.probabilities;
  if (typeof given !== 'object' || given === null) return null;
  const chances = given as Record<string, unknown>;
  const numbers: Record<string, number> = {};
  let top: string | null = null;
  for (const option of optionsOf(question)) {
    const chance = Object.hasOwn(chances, option) ? chances[option] : undefined;
    if (typeof chance !== 'number') continue;
    numbers[option] = chance;
    if (top === null || chance > numbers[top]!) top = option;
  }
  return top === null ? null : outcomeProbability(question, numbers, top);
}

/** A question's context without the capture it cites. */
function withoutCapture(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'captureId'));
}

/**
 * A question by its ID. With `lock`, the row is held until the transaction ends, so an answer
 * checks the question as it is when it closes.
 */
export async function getReview(
  db: Executor,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ReviewRow | null> {
  const query = db.select().from(reviewItems).where(eq(reviewItems.id, id));
  const [row] = options.lock === true ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * Closes an open question, once, with who answered and their note. Returns null when it wasn't
 * open. A flagged question waits for the owner (ruling 11): anyone else's answer doesn't close it.
 * A close that names no one is Spatula's own, as when the answer came another way.
 */
export async function closeReview(
  db: Executor,
  input: {
    id: string;
    status: 'decided' | 'dismissed';
    answer: string | null;
    at: Date;
    answeredBy?: ActorRecord;
    note?: string;
  },
): Promise<ReviewRow | null> {
  const byOwner = input.answeredBy === undefined || input.answeredBy.role === 'owner';
  const [row] = await db
    .update(reviewItems)
    .set({
      status: input.status,
      answer: input.answer,
      closedAt: input.at,
      answeredBy: input.answeredBy ?? null,
      note: input.note ?? null,
    })
    .where(
      and(
        eq(reviewItems.id, input.id),
        eq(reviewItems.status, 'open'),
        byOwner ? undefined : isNull(reviewItems.flaggedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Records who answered a question that closed another way: a publication question closes as its
 * snapshot is published or discarded (`publishHeld`, `discardHeld`). Returns false when the
 * question isn't decided, or says who answered it already.
 */
export async function recordAnswerer(
  db: Executor,
  input: { id: string; answeredBy: ActorRecord; note?: string },
): Promise<boolean> {
  const rows = await db
    .update(reviewItems)
    .set({ answeredBy: input.answeredBy, note: input.note ?? null })
    .where(
      and(
        eq(reviewItems.id, input.id),
        eq(reviewItems.status, 'decided'),
        isNull(reviewItems.answeredBy),
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length > 0;
}

/**
 * Sends an open question to the owner with a reviewer's answer that differs from a person's
 * (ruling 12). The first such answer is the one kept. Returns false when the question isn't open,
 * or was flagged already.
 */
export async function flagReview(
  db: Executor,
  input: { id: string; flag: ReviewFlag; at: Date },
): Promise<boolean> {
  const rows = await db
    .update(reviewItems)
    .set({ flaggedAt: input.at, flag: input.flag })
    .where(
      and(
        eq(reviewItems.id, input.id),
        eq(reviewItems.status, 'open'),
        isNull(reviewItems.flaggedAt),
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length > 0;
}

/**
 * Reopens a question a person answered, for the owner, with a reviewer's answer that differs
 * (ruling 12): an open copy, flagged. Its ID comes from the question's and the number of questions
 * its subject has had, so two answers sent at once make one copy, and a later disagreement another.
 * Returns the copy's ID, or null when no person answered the question, or another question about
 * its subject is open: that one is the question to answer.
 */
export async function reopenFlagged(
  db: Executor,
  input: { review: ReviewRow; flag: ReviewFlag; at: Date },
): Promise<string | null> {
  const { review } = input;
  if (review.status !== 'decided') return null;
  const [asked] = await db
    .select({ n: count() })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.datasetId, review.datasetId),
        eq(reviewItems.kind, review.kind),
        eq(reviewItems.subject, review.subject),
      ),
    );
  const [row] = await db
    .insert(reviewItems)
    .values({
      id: await stableId('rv', review.id, 'flag', asked?.n ?? 0),
      datasetId: review.datasetId,
      kind: review.kind,
      subject: review.subject,
      itemId: review.itemId,
      entityId: review.entityId,
      decisionId: review.decisionId,
      question: review.question,
      context: review.context,
      flaggedAt: input.at,
      flag: input.flag,
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .returning({ id: reviewItems.id });
  return row?.id ?? null;
}

/**
 * Whether the owner answered a copy of a question (`reopenFlagged`), found by the IDs its copies
 * take: the question's, and the number of questions its subject had then. Then the owner's answer
 * is the one that stands.
 */
export async function answeredAgainByOwner(db: Executor, review: ReviewRow): Promise<boolean> {
  const [asked] = await db
    .select({ n: count() })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.datasetId, review.datasetId),
        eq(reviewItems.kind, review.kind),
        eq(reviewItems.subject, review.subject),
      ),
    );
  const copies = await Promise.all(
    Array.from({ length: asked?.n ?? 0 }, (_, n) => stableId('rv', review.id, 'flag', n + 1)),
  );
  if (copies.length === 0) return false;
  const [row] = await db
    .select({ id: reviewItems.id })
    .from(reviewItems)
    .where(
      and(
        inArray(reviewItems.id, copies),
        eq(reviewItems.status, 'decided'),
        sql`${reviewItems.answeredBy}->>'role' = 'owner'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Puts the owner's suggested answer on an open question. Returns false when it isn't open. */
export async function setSuggestion(
  db: Executor,
  input: { id: string; suggestion: ReviewSuggestion },
): Promise<boolean> {
  const rows = await db
    .update(reviewItems)
    .set({ suggestion: input.suggestion })
    .where(and(eq(reviewItems.id, input.id), eq(reviewItems.status, 'open')))
    .returning({ id: reviewItems.id });
  return rows.length > 0;
}

/**
 * Dismisses the open question about a subject, when its answer came another way. A flagged one
 * waits for the owner (ruling 11), whatever a run finds meanwhile.
 */
export async function dismissReviews(
  db: Executor,
  input: { datasetId: string; kind: ReviewKind; subject: string; at: Date },
): Promise<number> {
  const rows = await db
    .update(reviewItems)
    .set({ status: 'dismissed', closedAt: input.at })
    .where(
      and(
        eq(reviewItems.datasetId, input.datasetId),
        eq(reviewItems.kind, input.kind),
        eq(reviewItems.subject, input.subject),
        eq(reviewItems.status, 'open'),
        isNull(reviewItems.flaggedAt),
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length;
}

/** Closes the open question about a subject with the answer it got, whichever way it came. */
export async function decideReviews(
  db: Executor,
  input: { datasetId: string; kind: ReviewKind; subject: string; answer: string; at: Date },
): Promise<number> {
  const rows = await db
    .update(reviewItems)
    .set({ status: 'decided', answer: input.answer, closedAt: input.at })
    .where(
      and(
        eq(reviewItems.datasetId, input.datasetId),
        eq(reviewItems.kind, input.kind),
        eq(reviewItems.subject, input.subject),
        eq(reviewItems.status, 'open'),
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length;
}

/** How many questions of each kind are open. */
export async function countOpenReviews(
  db: Executor,
  datasetId: string,
): Promise<Record<ReviewKind, number>> {
  const rows = await db
    .select({ kind: reviewItems.kind, count: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(and(eq(reviewItems.datasetId, datasetId), eq(reviewItems.status, 'open')))
    .groupBy(reviewItems.kind);
  const counts: Record<ReviewKind, number> = { classify: 0, match: 0, publication: 0 };
  for (const row of rows) counts[row.kind] = row.count;
  return counts;
}
