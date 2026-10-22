import {
  answerText,
  checkTaxonomyAnswer,
  emptyParts,
  finalAnswerText,
  freshen,
  matchVerdictOf,
  mergeAnswers,
  NONE_OF_THESE,
  NONE_SHELF,
  readFinalAnswer,
  resolveId,
  reviewAnswers,
  shelfPath,
  stableId,
  TAXONOMY_CRITERIA_VERSION,
  TAXONOMY_FIELDS,
  TAXONOMY_PROMPT,
  type ActorRecord,
  type GivenParts,
  type Question,
  type ReviewView,
  type StatementInput,
  type Taxonomy,
  type TaxonomyAnswer,
  type TaxonomyParts,
  withCarried,
} from '@spatula/core';
import {
  closeReview,
  currentTaxonomy,
  decisionWithId,
  discardHeld,
  finalizeDecision,
  flagReview,
  getReview,
  joinedEntityOf,
  judge,
  latestCapture,
  latestFetchId,
  latestFinalized,
  listOpenReviews,
  liveIfIrrelevant,
  lockPageVerdicts,
  logAction,
  recordAnswerer,
  reopenFlagged,
  sameVerdictsOf,
  saveDecision,
  setItemStatus,
  setSuggestion,
  setTaxonomyKey,
  writeStatements,
  type DecisionRow,
  type Executor,
  type ReviewRow,
} from '@spatula/store';
import { CASCADE_METHODS } from './classify';
import type { RefreshPorts } from './pipeline';
import { publishHeldSnapshot } from './publish';
import { keyHash, partStatements, placeHash, placeSubject, type PlaceState } from './taxonomy';

/*
 * A person's answers (ADR 0003, ADR 0009). An answer is one of a question's options, a taxonomy
 * question's parts, or the suggestion the owner put on the question, and a match question asked
 * before the relationships takes the relationships too (`reviewAnswers`). It finalizes the decision
 * that asked, and takes effect as a person's word: a classification or a page's place becomes human
 * statements, which outrank every other, or takes the page out of the dataset; a match becomes a
 * person's verdict, which only a person can change. Both reach the snapshot at the next run. A
 * publication answer publishes or discards the held snapshot at once, and is the owner's.
 *
 * Who answers ranks (ruling 12): the owner, then a consumer's reviewer, then the decider. A
 * reviewer's answer that differs from a person's never replaces it: it flags the question for the
 * owner, and a flagged question waits for the owner alone. Every answer, flag, and suggestion goes
 * in the review log with who made it (ruling 14).
 */

export type ReviewAnswer =
  | { kind: 'answered'; effect: string }
  | { kind: 'flagged'; reviewId: string }
  | { kind: 'missing' }
  | { kind: 'closed' }
  | { kind: 'refused'; status: 400 | 403 | 409; reason: string };

export type ReviewPorts = Pick<RefreshPorts, 'withDb' | 'blobs' | 'now'>;

/** An answer: exactly one of an option, a taxonomy question's parts, or its suggestion. */
export interface AnswerInput {
  datasetId: string;
  reviewId: string;
  answer?: string;
  parts?: GivenParts;
  suggestion?: boolean;
  note?: string;
  /** Who answers: the owner, through the CLI, unless said. */
  actor?: ActorRecord;
}

/** The most answers one bulk request takes (ruling 13). */
export const MAX_BULK = 500;

/** Who answered before there were roles: the owner, through the CLI. */
const OWNER_CLI: ActorRecord = { role: 'owner', client: 'cli' };

type Refusal = Extract<ReviewAnswer, { kind: 'refused' }>;

const refused = (status: Refusal['status'], reason: string): Refusal => ({
  kind: 'refused',
  status,
  reason,
});

/** What an answer says: one of the question's options, or parts. */
type Said = { option: string } | { parts: GivenParts };

export async function answerReview(ports: ReviewPorts, input: AnswerInput): Promise<ReviewAnswer> {
  const actor = input.actor ?? OWNER_CLI;
  const owner = actor.role === 'owner';
  const sent = [input.answer, input.parts, input.suggestion === true ? true : undefined];
  if (sent.filter((one) => one !== undefined).length !== 1) {
    return refused(400, 'Send one of: an answer, parts, or suggestion: true.');
  }
  const at = ports.now();
  const review = await ports.withDb((db) => getReview(db, input.reviewId));
  if (review === null || review.datasetId !== input.datasetId) return { kind: 'missing' };
  if (review.kind === 'publication' && !owner) {
    return refused(403, 'Only the owner answers a publication question.');
  }
  // A flagged question waits for the owner (ruling 11): to anyone else, it isn't there.
  if (review.status === 'open' && review.flaggedAt !== null && !owner) return { kind: 'missing' };
  // The owner's answer to a closed question changes nothing, whatever it is, as before roles.
  if (review.status !== 'open' && (owner || review.status !== 'decided')) {
    return { kind: 'closed' };
  }
  const said = whatWasSaid(review, input);
  if ('kind' in said) return said;
  if (review.status !== 'open') return flagAnswered(ports, review, said, actor, at);
  if ('parts' in said) return answerParts(ports, review.id, said.parts, input.note, actor, at);
  const options = reviewAnswers(review.kind, review.question);
  if (!options.includes(said.option)) {
    return refused(400, `Answer with one of: ${options.join(', ')}.`);
  }
  if (review.kind === 'publication') {
    return answerPublication(ports, review, said.option, input.note, actor, at);
  }
  return answerOption(ports, review, said.option, input.note, actor, at);
}

/**
 * What an answer says, the question's suggestion taken when it asks for that. A taxonomy question
 * takes parts, and any other question one of its options.
 */
function whatWasSaid(review: ReviewRow, input: AnswerInput): Said | Refusal {
  let said: Said;
  if (input.suggestion === true) {
    if (review.suggestion === null) return refused(409, 'This question has no suggestion.');
    said =
      'answer' in review.suggestion
        ? { option: review.suggestion.answer }
        : { parts: review.suggestion };
  } else {
    said = input.parts !== undefined ? { parts: input.parts } : { option: input.answer ?? '' };
  }
  const taxonomy = review.question.type === 'taxonomy';
  if ('parts' in said === taxonomy) return said;
  if (input.suggestion === true) return refused(409, 'This question’s suggestion doesn’t fit it.');
  if (taxonomy) return refused(400, 'A taxonomy question is answered part by part.');
  const options = reviewAnswers(review.kind, review.question);
  return refused(400, `Answer with one of: ${options.join(', ')}.`);
}

/**
 * A reviewer's answer to a question a person answered (ruling 12). The same answer changes
 * nothing, and a match answer that does to the page what the person's did is the same answer
 * (`saysTheSame`). A different one reopens the question for the owner, flagged with it, unless
 * another question about the subject is open: then that one is the question to answer.
 */
async function flagAnswered(
  ports: ReviewPorts,
  review: ReviewRow,
  said: Said,
  actor: ActorRecord,
  at: Date,
): Promise<ReviewAnswer> {
  return ports.withDb((db) =>
    db.transaction(async (tx): Promise<ReviewAnswer> => {
      let answer: unknown;
      let text: string;
      if ('parts' in said) {
        const taxonomy = await taxonomyNow(tx, review.datasetId);
        const checked = checkParts(taxonomy, review.question, review.context, said.parts);
        if (!checked.ok) return refused(400, checked.reason);
        answer = checked.given;
        text = answerText(checked.given);
      } else {
        const options = reviewAnswers(review.kind, review.question);
        if (!options.includes(said.option)) {
          return refused(400, `Answer with one of: ${options.join(', ')}.`);
        }
        answer = said.option;
        text = said.option;
      }
      if (saysTheSame(review, text)) return { kind: 'closed' };
      const flag = { actor, answer, at: at.toISOString() };
      const reopened = await reopenFlagged(tx, { review, flag, at });
      if (reopened === null) return { kind: 'closed' };
      await logAction(tx, {
        datasetId: review.datasetId,
        action: 'flag',
        subject: review.id,
        actor,
        detail: { kind: review.kind, about: review.subject, answer, reopened },
        at,
      });
      return { kind: 'flagged', reviewId: reopened };
    }),
  );
}

/**
 * Whether an answer says what the question's answer said. A match answer says it when it records
 * the same verdict: other-model after unrelated, or after an old question's different, keeps the
 * page apart all the same. Only a join, an edition, or apart in place of either says otherwise.
 */
function saysTheSame(review: ReviewRow, text: string): boolean {
  if (review.answer === null) return false;
  return review.kind === 'match'
    ? matchVerdictOf(text) === matchVerdictOf(review.answer)
    : text === review.answer;
}

/** Sends an open question to the owner with a reviewer's answer (ruling 12), and logs it. */
async function flagOpen(
  tx: Executor,
  review: ReviewRow,
  answer: unknown,
  actor: ActorRecord,
  at: Date,
): Promise<ReviewAnswer> {
  const flagged = await flagReview(tx, {
    id: review.id,
    flag: { actor, answer, at: at.toISOString() },
    at,
  });
  // It closed meanwhile, or another reviewer's answer flagged it first.
  if (!flagged) return { kind: 'closed' };
  await logAction(tx, {
    datasetId: review.datasetId,
    action: 'flag',
    subject: review.id,
    actor,
    detail: { kind: review.kind, about: review.subject, answer },
    at,
  });
  return { kind: 'flagged', reviewId: review.id };
}

/** Logs an answer, with what it said and what it did (ruling 14). */
function logAnswer(
  db: Executor,
  review: ReviewRow,
  said: Record<string, unknown>,
  effect: string,
  note: string | undefined,
  actor: ActorRecord,
  at: Date,
): Promise<string> {
  return logAction(db, {
    datasetId: review.datasetId,
    action: 'answer',
    subject: review.id,
    actor,
    detail: {
      kind: review.kind,
      about: review.subject,
      ...said,
      effect,
      ...(note === undefined ? {} : { note }),
    },
    at,
  });
}

/** An option for a classification or a match. */
async function answerOption(
  ports: ReviewPorts,
  review: ReviewRow,
  answer: string,
  note: string | undefined,
  actor: ActorRecord,
  at: Date,
): Promise<ReviewAnswer> {
  return ports.withDb((db) =>
    db.transaction(async (tx): Promise<ReviewAnswer> => {
      // A join about a page, as the same product or an edition, is checked first, under the page's
      // lock, and closing is the first write, so two answers sent at once can't both take effect.
      if (review.kind === 'match' && matchVerdictOf(answer) !== 'not_same') {
        const refusal = await refuseSecondRecord(tx, review);
        // What the owner is refused, a reviewer's answer sends to the owner (ruling 12).
        if (refusal !== null) {
          return actor.role === 'owner' ? refusal : flagOpen(tx, review, answer, actor, at);
        }
      }
      const closed = await closeReview(tx, {
        id: review.id,
        status: 'decided',
        answer,
        at,
        answeredBy: actor,
        note,
      });
      if (closed === null) return { kind: 'closed' };
      // While a question waits, a run that asks again moves it to a newer decision (`openReview`),
      // so what follows goes by the row that closed, not by the one read before.
      if (closed.decisionId !== null) {
        await finalizeDecision(tx, { id: closed.decisionId, finalAnswer: answer, at });
      }
      const effect =
        closed.kind === 'classify'
          ? await answerClassification(tx, closed, answer, at)
          : await answerMatch(tx, closed, answer, at);
      await logAnswer(tx, closed, { answer }, effect, note, actor, at);
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
  // It cites the page's latest capture, which shows what the person judged (ADR 0008).
  const capture = await latestCapture(tx, review.itemId);
  const write = {
    datasetId: review.datasetId,
    itemId: review.itemId,
    fetchId,
    seenAt: at,
    properties: [field],
    captureId: capture?.id ?? null,
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
  const verdict = matchVerdictOf(answer);
  await judge(tx, {
    datasetId: review.datasetId,
    itemId: review.itemId,
    entityId: review.entityId,
    verdict,
    who: 'person',
    confidence: 1,
    decisionId: review.decisionId,
    at,
  });
  if (verdict === 'same') return 'The page joins that record at the next run.';
  if (verdict === 'edition') return 'The page joins that record as an edition at the next run.';
  return 'The page stays apart from that record; the next run gives it its own, or asks about another.';
}

/**
 * A page joins one record, as the same product or as an edition. Resolution joins a page only to
 * the one a person chose, so two persons' joins for one page about two records would leave it
 * joined to neither. The second is refused here, where the person can see why, and its question
 * stays open. A decider's "same" about another record doesn't refuse it: a person's answer
 * overrides a decider's. The page's lock is held to the end of the transaction, so the check reads
 * what any other answer about the page committed.
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
      reason: `A person already said this page joins ${chosen.entityId}, and a page joins one record. Answer spec-version, other-model, or unrelated.`,
    };
  }
  const joined = await joinedEntityOf(tx, review.itemId);
  if (joined !== null && joined !== review.entityId) {
    return {
      kind: 'refused',
      status: 409,
      reason: `This page is already joined to ${joined}, and a page joins one record. Answer spec-version, other-model, or unrelated.`,
    };
  }
  return null;
}

/**
 * The owner's answer to a held snapshot's question. Its question closes as the snapshot is
 * published or discarded; once that has taken effect, who answered, and their note, go on the
 * question and in the log.
 */
async function answerPublication(
  ports: ReviewPorts,
  review: ReviewRow,
  answer: string,
  note: string | undefined,
  actor: ActorRecord,
  at: Date,
): Promise<ReviewAnswer> {
  const result = await publishOrDiscard(ports, review, answer, at);
  if (result.kind === 'answered') {
    await ports.withDb((db) =>
      db.transaction(async (tx) => {
        await recordAnswerer(tx, { id: review.id, answeredBy: actor, note });
        await logAnswer(tx, review, { answer }, result.effect, note, actor, at);
      }),
    );
  }
  return result;
}

/**
 * Publishing and discarding close the snapshot's question in the same transaction (`publishHeld`
 * and `discardHeld` in the store), so an answer that loses a race to another, or to a newer run,
 * finds the snapshot no longer held.
 */
async function publishOrDiscard(
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
      : refused(409, 'That snapshot isn’t held any more.');
  }
  const published = await publishHeldSnapshot(ports, { datasetId: review.datasetId, snapshotId });
  if (published.kind === 'stale') return refused(409, staleReason(published.state));
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

/**
 * A person's parts for a taxonomy question (ADR 0007), checked against the question as it is when
 * it closes, under the taxonomy as it is now: a run that asks again can change the question's
 * parts, and a merge since can rename what it offered. A reviewer's shelf that differs from a
 * person's standing one goes to the owner instead (ruling 12).
 */
async function answerParts(
  ports: ReviewPorts,
  reviewId: string,
  parts: GivenParts,
  note: string | undefined,
  actor: ActorRecord,
  at: Date,
): Promise<ReviewAnswer> {
  return ports.withDb((db) =>
    db.transaction(async (tx): Promise<ReviewAnswer> => {
      const review = await getReview(tx, reviewId, { lock: true });
      if (review === null || review.status !== 'open') return { kind: 'closed' };
      const owner = actor.role === 'owner';
      if (review.flaggedAt !== null && !owner) return { kind: 'missing' };
      const taxonomy = await taxonomyNow(tx, review.datasetId);
      const checked = checkParts(taxonomy, review.question, review.context, parts);
      if (!checked.ok) return refused(400, checked.reason);
      const { asked, settled, given } = checked;
      if (!owner && differsFromPerson(taxonomy, review.context, given)) {
        return flagOpen(tx, review, given, actor, at);
      }
      const asking =
        review.decisionId === null ? null : await decisionWithId(tx, review.decisionId);
      const state = (asking?.state ?? {}) as Partial<PlaceState>;
      const itemId = review.itemId;
      if (asking === null || state.page === undefined || itemId === null) {
        throw new Error(`Review ${review.id} has no page and place decision to answer for`);
      }
      const closed = await closeReview(tx, {
        id: review.id,
        status: 'decided',
        answer: answerText(given),
        at,
        answeredBy: actor,
        note,
      });
      if (closed === null) return { kind: 'closed' };
      const effect = await place(tx, {
        taxonomy,
        review: closed,
        itemId,
        asking,
        state: { page: state.page, rule: state.rule ?? null, asked: state.asked ?? emptyParts() },
        asked,
        given,
        answer: mergeAnswers(taxonomy, settled, given),
        note,
        at,
      });
      await logAnswer(tx, closed, { parts: given }, effect, note, actor, at);
      return { kind: 'answered', effect };
    }),
  );
}

/**
 * Places a page as a person answered (ADR 0007). Their answer is a decision of its own, found again
 * under the key of the shelf it puts the page on, and finalized with what they were asked and said,
 * which carries over to the page's next question (ruling 7). It's their whole answer: what a
 * person's earlier answer about the page decided, and this question didn't ask again, joins it
 * (`withCarried`), so answering a later question keeps the earlier one. Its parts are human
 * statements in place of the cascade's and the earlier answer's, citing the page's latest fetch and
 * capture, which the person judged. "None of these" takes the page out; a shelf brings back a page
 * the decider took out. Returns what the answer does.
 */
async function place(
  tx: Executor,
  input: {
    taxonomy: Taxonomy;
    review: ReviewRow;
    itemId: string;
    asking: DecisionRow;
    state: Pick<PlaceState, 'page' | 'rule' | 'asked'>;
    asked: TaxonomyParts;
    given: TaxonomyAnswer;
    answer: TaxonomyAnswer;
    note: string | undefined;
    at: Date;
  },
): Promise<string> {
  const { taxonomy, review, itemId, asking, at } = input;
  // Read before this answer's decision is saved and finalized, which would be the latest then.
  const previous = await latestFinalized(tx, { datasetId: review.datasetId, subject: itemId });
  const whole = withCarried(
    taxonomy,
    { answer: input.answer, asked: input.asked, given: input.given },
    readFinalAnswer(previous?.finalAnswer ?? null),
  );
  const shelf = whole.answer.shelf;
  const state: PlaceState = { ...input.state, key: await keyHash(taxonomy, shelf) };
  const decision = await saveDecision(tx, {
    id: await stableId('dc', review.id, 'answer'),
    datasetId: review.datasetId,
    type: 'taxonomy',
    subject: itemId,
    subjectKey: placeSubject(itemId),
    state,
    stateHash: await placeHash(state),
    question: { type: 'taxonomy', prompt: TAXONOMY_PROMPT, parts: input.asked },
    criteriaVersion: TAXONOMY_CRITERIA_VERSION,
    adapter: null,
    probabilities: asking.probabilities,
    evidence: input.note ?? 'A person answered.',
    thresholds: asking.thresholds,
    outcome: 'escalated',
    answer: answerText(whole.answer),
    inputTokens: 0,
    outputTokens: 0,
    decidedAt: at,
  });
  await finalizeDecision(tx, {
    id: decision.id,
    finalAnswer: finalAnswerText(whole),
    at,
  });
  const fetchId = await latestFetchId(tx, itemId);
  if (fetchId === null) throw new Error(`${itemId} has no fetch to record the answer against`);
  const capture = await latestCapture(tx, itemId);
  const write = {
    datasetId: review.datasetId,
    itemId,
    fetchId,
    seenAt: at,
    captureId: capture?.id ?? null,
    properties: TAXONOMY_FIELDS,
  };
  const none = shelf === NONE_SHELF;
  // "None of these" withdraws all the page's place says, a person's earlier answer too, as a
  // classification's does: a shelf of theirs left standing, retired since, would reopen their
  // question in place of keeping the page out (`keepOut` in ./taxonomy).
  await writeStatements(tx, { ...write, methods: CASCADE_METHODS, statements: [] });
  await writeStatements(tx, {
    ...write,
    methods: ['human'],
    statements: none
      ? []
      : partStatements(taxonomy, whole.answer, {
          shelf: 'human',
          parts: 'human',
          confidence: () => 1,
          path: `decision:${decision.id}`,
        }),
  });
  await setTaxonomyKey(tx, itemId, state.key);
  if (none) {
    await setItemStatus(tx, itemId, 'irrelevant');
    return 'The page leaves the dataset; spatula revive puts it back.';
  }
  await liveIfIrrelevant(tx, itemId);
  return shelf === null
    ? 'The parts are answered. The page has no shelf yet, so it stays out of the snapshot.'
    : `The page sits on ${shelfPath(taxonomy, shelf)}. The next run publishes it.`;
}

/** The dataset's taxonomy now. A taxonomy question can't wait in a dataset without one. */
async function taxonomyNow(db: Executor, datasetId: string): Promise<Taxonomy> {
  const current = await currentTaxonomy(db, datasetId);
  if (current === null) throw new Error(`${datasetId} has no taxonomy to answer in`);
  return current.taxonomy;
}

/** A person's parts, checked against the question freshened to this taxonomy. */
function checkParts(
  taxonomy: Taxonomy,
  question: Question,
  context: Record<string, unknown>,
  parts: GivenParts,
):
  | { ok: true; asked: TaxonomyParts; settled: TaxonomyAnswer; given: TaxonomyAnswer }
  | { ok: false; reason: string } {
  if (question.type !== 'taxonomy') {
    return { ok: false, reason: 'Only a taxonomy question is answered part by part.' };
  }
  const now = freshen(taxonomy, {
    settled: answerOf(context.settled),
    open: question.parts,
    proposed: answerOf(context.proposed),
    fallback: false,
  });
  // The values a person ticks are checked against the page's shelf: theirs, or the settled one.
  const checked = checkTaxonomyAnswer(taxonomy, now.open, parts, now.settled.shelf);
  if (!checked.ok) return checked;
  return { ok: true, asked: now.open, settled: now.settled, given: checked.given };
}

/** An answer a question's context holds, as applyPlace wrote it; an empty one for anything else. */
function answerOf(value: unknown): TaxonomyAnswer {
  if (typeof value !== 'object' || value === null) {
    return { shelf: null, functions: [], values: [] };
  }
  const answer = value as Record<string, unknown>;
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((one): one is string => typeof one === 'string') : [];
  return {
    shelf: typeof answer.shelf === 'string' ? answer.shelf : null,
    functions: ids(answer.functions),
    values: ids(answer.values),
  };
}

/**
 * Whether a reviewer's parts differ from a person's answer that still stands (ruling 12): the shelf,
 * or "None of these", that a reopened question shows as `earlier`. A shelf retired since doesn't
 * stand, which is why the question reopened, so a reviewer may answer that one.
 */
function differsFromPerson(
  taxonomy: Taxonomy,
  context: Record<string, unknown>,
  given: TaxonomyAnswer,
): boolean {
  if (context.earlier === undefined) return false;
  const earlier = answerOf(context.earlier).shelf;
  const standing =
    earlier === null || earlier === NONE_SHELF ? earlier : resolveId(taxonomy, 'shelf', earlier);
  return standing !== null && given.shelf !== null && given.shelf !== standing;
}

/** One answer in a bulk request: an option, parts, or the question's suggestion. */
export type BulkAnswer =
  | { reviewId: string; answer: string }
  | { reviewId: string; parts: GivenParts }
  | { reviewId: string; suggestion: true };

/** What became of one answer in a bulk request. One that failed is reported, not thrown. */
export interface BulkResult {
  reviewId: string;
  result: ReviewAnswer | { kind: 'failed'; error: string };
}

/**
 * Answers up to MAX_BULK questions (ruling 13), one after another and each on its own: one that's
 * refused, or fails, leaves the others as they come. The note goes with each.
 */
export async function answerReviews(
  ports: ReviewPorts,
  input: {
    datasetId: string;
    answers: readonly BulkAnswer[];
    note?: string;
    actor?: ActorRecord;
  },
): Promise<BulkResult[]> {
  if (input.answers.length > MAX_BULK) {
    throw new RangeError(`At most ${MAX_BULK} answers at once`);
  }
  const results: BulkResult[] = [];
  for (const sent of input.answers) {
    const said =
      'answer' in sent
        ? { answer: sent.answer }
        : 'parts' in sent
          ? { parts: sent.parts }
          : { suggestion: true };
    try {
      const result = await answerReview(ports, {
        datasetId: input.datasetId,
        reviewId: sent.reviewId,
        ...said,
        note: input.note,
        actor: input.actor,
      });
      results.push({ reviewId: sent.reviewId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ reviewId: sent.reviewId, result: { kind: 'failed', error: message } });
    }
  }
  return results;
}

/** One of the owner's suggestions: a page, by its address, and its parts, by slug or ID. */
export interface Suggestion {
  page: string;
  parts: GivenParts;
}

export type SuggestionResult =
  | { page: string; kind: 'suggested'; reviewId: string }
  | { page: string; kind: 'missing' }
  | { page: string; kind: 'refused'; reason: string };

/**
 * Puts the owner's suggestions on the open taxonomy questions about these pages (ruling 13). Each
 * is checked as an answer would be, and kept by ID. A suggestion answers nothing: an answer with
 * `suggestion: true` takes it, and checks it again then.
 */
export async function suggestAnswers(
  ports: ReviewPorts,
  input: { datasetId: string; suggestions: readonly Suggestion[]; actor?: ActorRecord },
): Promise<SuggestionResult[]> {
  const actor = input.actor ?? OWNER_CLI;
  if (actor.role !== 'owner') {
    return input.suggestions.map(
      ({ page }): SuggestionResult => ({
        page,
        kind: 'refused',
        reason: 'Suggestions are the owner’s.',
      }),
    );
  }
  return ports.withDb(async (db) => {
    const current = await currentTaxonomy(db, input.datasetId);
    const byPage = new Map<string, ReviewView>();
    for (const review of await listOpenReviews(db, input.datasetId, { kind: 'classify' })) {
      if (review.question.type === 'taxonomy' && typeof review.context.url === 'string') {
        byPage.set(review.context.url, review);
      }
    }
    const results: SuggestionResult[] = [];
    for (const { page, parts } of input.suggestions) {
      // A sitemap's pages are kept as their href, and a pages source's as the definition wrote
      // them, so an address is looked for in both forms.
      const review =
        byPage.get(page) ?? (URL.canParse(page) ? byPage.get(new URL(page).href) : undefined);
      if (review === undefined || current === null) {
        results.push({ page, kind: 'missing' });
        continue;
      }
      const checked = checkParts(current.taxonomy, review.question, review.context, parts);
      if (!checked.ok) {
        results.push({ page, kind: 'refused', reason: checked.reason });
        continue;
      }
      const suggestion = partsById(checked.asked, checked.given);
      const put = await db.transaction(async (tx) => {
        if (!(await setSuggestion(tx, { id: review.id, suggestion }))) return false;
        await logAction(tx, {
          datasetId: input.datasetId,
          action: 'suggest',
          subject: review.id,
          actor,
          detail: { page, parts: suggestion },
          at: ports.now(),
        });
        return true;
      });
      results.push(
        put ? { page, kind: 'suggested', reviewId: review.id } : { page, kind: 'missing' },
      );
    }
    return results;
  });
}

/**
 * A checked answer as a suggestion keeps it, by ID: the shelf when the question asks for it, the
 * functions, and the values by feature.
 */
function partsById(asked: TaxonomyParts, given: TaxonomyAnswer): GivenParts {
  const features: Record<string, string[]> = {};
  for (const [feature, offered] of Object.entries(asked.features)) {
    const chosen = given.values.filter((value) => offered.includes(value));
    if (chosen.length > 0) features[feature] = chosen;
  }
  return {
    ...(asked.shelves.length > 0 && given.shelf !== null ? { shelf: given.shelf } : {}),
    functions: given.functions,
    features,
  };
}
