import { NONE_OF_THESE, optionsOf, type StatementInput } from '@spatula/core';
import {
  closeReview,
  discardHeld,
  finalizeDecision,
  getReview,
  joinedEntityOf,
  judge,
  latestFetchId,
  lockPageVerdicts,
  sameVerdictsOf,
  setItemStatus,
  writeStatements,
  type Executor,
  type ReviewRow,
} from '@spatula/store';
import { CASCADE_METHODS } from './classify';
import type { RefreshPorts } from './pipeline';
import { publishHeldSnapshot } from './publish';

/*
 * A person's answers (ADR 0003). An answer is one of the question's options. It finalizes the
 * decision that asked, and takes effect as a person's word: a classification becomes a human
 * statement, which outranks every other, or takes the page out of the dataset; a match becomes a
 * person's verdict, which only a person can change. Both reach the snapshot at the next run. A
 * publication answer publishes or discards the held snapshot at once.
 */

export type ReviewAnswer =
  | { kind: 'answered'; effect: string }
  | { kind: 'missing' }
  | { kind: 'closed' }
  | { kind: 'refused'; status: 400 | 409; reason: string };

type ReviewPorts = Pick<RefreshPorts, 'withDb' | 'blobs' | 'now'>;

export async function answerReview(
  ports: ReviewPorts,
  input: { datasetId: string; reviewId: string; answer: string },
): Promise<ReviewAnswer> {
  const at = ports.now();
  const review = await ports.withDb((db) => getReview(db, input.reviewId));
  if (review === null || review.datasetId !== input.datasetId) return { kind: 'missing' };
  if (review.status !== 'open') return { kind: 'closed' };
  const options = optionsOf(review.question);
  if (!options.includes(input.answer)) {
    return { kind: 'refused', status: 400, reason: `Answer with one of: ${options.join(', ')}.` };
  }
  if (review.kind === 'publication') return answerPublication(ports, review, input.answer, at);
  return ports.withDb((db) =>
    db.transaction(async (tx): Promise<ReviewAnswer> => {
      // A "same" about a page is checked first, under the page's lock, and closing is the first
      // write, so two answers sent at once can't both take effect.
      if (review.kind === 'match' && input.answer === 'same') {
        const refusal = await refuseSecondRecord(tx, review);
        if (refusal !== null) return refusal;
      }
      const closed = await closeReview(tx, {
        id: review.id,
        status: 'decided',
        answer: input.answer,
        at,
      });
      if (closed === null) return { kind: 'closed' };
      // While a question waits, a run that asks again moves it to a newer decision (`openReview`),
      // so what follows goes by the row that closed, not by the one read before.
      if (closed.decisionId !== null) {
        await finalizeDecision(tx, { id: closed.decisionId, finalAnswer: input.answer, at });
      }
      const effect =
        closed.kind === 'classify'
          ? await answerClassification(tx, closed, input.answer, at)
          : await answerMatch(tx, closed, input.answer, at);
      return { kind: 'answered', effect };
    }),
  );
}

async function answerClassification(
  tx: Executor,
  review: ReviewRow,
  answer: string,
  at: Date,
): Promise<string> {
  const field = typeof review.context.field === 'string' ? review.context.field : null;
  if (review.itemId === null || field === null) {
    throw new Error(`Review ${review.id} doesn’t say which page and field it’s about`);
  }
  // A person's statement is recorded against the page's latest fetch, which it judged.
  const fetchId = await latestFetchId(tx, review.itemId);
  if (fetchId === null) {
    throw new Error(`${review.itemId} has no fetch to record the answer against`);
  }
  const write = {
    datasetId: review.datasetId,
    itemId: review.itemId,
    fetchId,
    seenAt: at,
    properties: [field],
  };
  await writeStatements(tx, { ...write, methods: CASCADE_METHODS, statements: [] });
  if (answer === NONE_OF_THESE) {
    await writeStatements(tx, { ...write, methods: ['human'], statements: [] });
    await setItemStatus(tx, review.itemId, 'irrelevant');
    return 'The page leaves the dataset; spatula revive puts it back.';
  }
  const statement: StatementInput = {
    property: field,
    value: answer,
    valueKey: answer,
    original: answer,
    method: 'human',
    // The path names the decision the person answered, as the cascade's own statements do.
    path: review.decisionId === null ? `review:${review.id}` : `decision:${review.decisionId}`,
    confidence: 1,
    position: null,
  };
  await writeStatements(tx, { ...write, methods: ['human'], statements: [statement] });
  return `The page’s ${field} is ${answer}. The next run publishes it.`;
}

async function answerMatch(
  tx: Executor,
  review: ReviewRow,
  answer: string,
  at: Date,
): Promise<string> {
  if (review.itemId === null || review.entityId === null) {
    throw new Error(`Review ${review.id} doesn’t say which page and record it’s about`);
  }
  await judge(tx, {
    datasetId: review.datasetId,
    itemId: review.itemId,
    entityId: review.entityId,
    verdict: answer === 'same' ? 'same' : 'not_same',
    who: 'person',
    confidence: 1,
    decisionId: review.decisionId,
    at,
  });
  return answer === 'same'
    ? 'The page joins that record at the next run.'
    : 'The page stays apart from that record; the next run gives it its own, or asks about another.';
}

/**
 * A page joins one record. Resolution joins a page only to the one a person chose, so two persons'
 * "same" for one page about two records would leave it joined to neither. The second is refused
 * here, where the person can see why, and its question stays open. A decider's "same" about
 * another record doesn't refuse it: a person's answer overrides a decider's. The page's lock is
 * held to the end of the transaction, so the check reads what any other answer about the page
 * committed.
 */
async function refuseSecondRecord(tx: Executor, review: ReviewRow): Promise<ReviewAnswer | null> {
  if (review.itemId === null || review.entityId === null) return null;
  await lockPageVerdicts(tx, review.itemId);
  const chosen = (await sameVerdictsOf(tx, review.itemId)).find(
    (verdict) => verdict.who === 'person' && verdict.entityId !== review.entityId,
  );
  if (chosen !== undefined) {
    return {
      kind: 'refused',
      status: 409,
      reason: `A person already said this page is the same product as ${chosen.entityId}, and a page joins one record. Answer variant or different.`,
    };
  }
  const joined = await joinedEntityOf(tx, review.itemId);
  if (joined !== null && joined !== review.entityId) {
    return {
      kind: 'refused',
      status: 409,
      reason: `This page is already joined to ${joined}, and a page joins one record. Answer variant or different.`,
    };
  }
  return null;
}

/**
 * Publishing and discarding close the snapshot's question in the same transaction (Task 15), so an
 * answer that loses a race to another, or to a newer run, finds the snapshot no longer held.
 */
async function answerPublication(
  ports: ReviewPorts,
  review: ReviewRow,
  answer: string,
  at: Date,
): Promise<ReviewAnswer> {
  const snapshotId = review.subject;
  if (answer === 'discard') {
    const discarded = await ports.withDb((db) => discardHeld(db, { snapshotId, at }));
    return discarded
      ? { kind: 'answered', effect: 'The held snapshot is discarded.' }
      : { kind: 'refused', status: 409, reason: 'That snapshot isn’t held any more.' };
  }
  const published = await publishHeldSnapshot(ports, { datasetId: review.datasetId, snapshotId });
  if (published.kind === 'stale') {
    return { kind: 'refused', status: 409, reason: staleReason(published.state) };
  }
  return { kind: 'answered', effect: `Published as generation ${published.generation}.` };
}

/** What became of a snapshot that can't be published any more. */
function staleReason(state: string): string {
  switch (state) {
    case 'published':
      return 'That snapshot is published already.';
    case 'superseded':
      return 'A newer run replaced that snapshot.';
    case 'discarded':
      return 'That snapshot was discarded.';
    default:
      return `That snapshot is ${state}, so it can’t be published.`;
  }
}
