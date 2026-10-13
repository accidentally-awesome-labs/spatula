import type { Question, ReviewView } from '@spatula/core';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import {
  decisionRecords,
  judgements,
  reviewItems,
  type DecisionOutcome,
  type Judge,
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

/** The dataset's open questions, oldest first. */
export async function listOpenReviews(db: Executor, datasetId: string): Promise<ReviewView[]> {
  const rows = await db
    .select({
      id: reviewItems.id,
      kind: reviewItems.kind,
      subject: reviewItems.subject,
      question: reviewItems.question,
      context: reviewItems.context,
      createdAt: reviewItems.createdAt,
    })
    .from(reviewItems)
    .where(and(eq(reviewItems.datasetId, datasetId), eq(reviewItems.status, 'open')))
    .orderBy(asc(reviewItems.createdAt), asc(reviewItems.id));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function getReview(db: Executor, id: string): Promise<ReviewRow | null> {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row ?? null;
}

/** Closes an open question, once. Returns null when it wasn't open. */
export async function closeReview(
  db: Executor,
  input: { id: string; status: 'decided' | 'dismissed'; answer: string | null; at: Date },
): Promise<ReviewRow | null> {
  const [row] = await db
    .update(reviewItems)
    .set({ status: input.status, answer: input.answer, closedAt: input.at })
    .where(and(eq(reviewItems.id, input.id), eq(reviewItems.status, 'open')))
    .returning();
  return row ?? null;
}

/** Dismisses the open question about a subject, when its answer came another way. */
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
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length;
}
