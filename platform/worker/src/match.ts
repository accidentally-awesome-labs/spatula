import {
  cascade,
  GENERIC_MATCH_CRITERIA,
  lineupNote,
  matchEvidence,
  matchQuestion,
  matchVerdictOf,
  optionsOf,
  outcomeProbability,
  stableId,
  stateHash,
  type CascadeOutcome,
  type LineupEntry,
  type LlmUsage,
} from '@spatula/core';
import {
  anyRefusesAiInput,
  dismissReviews,
  findDecision,
  judge,
  matchSides,
  openReview,
  saveDecision,
  sameVerdictsOf,
  type DecisionRow,
  type Executor,
} from '@spatula/store';
import { likeliest, stands, weighed } from './classify';
import { NO_USAGE, type Context, type RefreshPorts } from './pipeline';
import { storable } from './text';

/*
 * One match question (ADR 0003): how is this page related to this entity? The same product, an
 * edition of it, a version whose specifications differ, another model, or an unrelated product.
 * The decider sees both records' values side by side, the entity's known editions, and the other
 * records in the page's brand, never their pages' text, and answers where the dataset and every
 * page's site allow AI input. Its likeliest relationship is taken when the relationships with the
 * same outcome add up to the threshold: "same" joins the page to the entity, "edition" joins it as
 * an edition, and the rest keep it apart. An answer that isn't sure enough goes to a person while
 * the page waits. A decider's join is no exception to that where the page is judged to join
 * another entity already: that contradicts it, and a person says which. A question answered
 * before, on the same evidence, isn't asked again unless asking might now come to something else
 * (`stands`, in classify.ts). The lineup is shown, and kept in the decision's evidence text, but it
 * isn't part of the question's key.
 */

export interface Matched {
  outcome: 'accepted' | 'escalated' | 'reused' | 'skipped' | 'failed';
  usage: LlmUsage;
  note: string | null;
}

export async function matchItem(
  context: Context,
  question: { itemId: string; entityId: string; lineup?: readonly LineupEntry[] },
  budgetLeft: number,
  ports: RefreshPorts,
): Promise<Matched> {
  const { datasetId, definition, runId } = context;
  const { itemId, entityId } = question;
  // A question from a resolution that an earlier version kept has no lineup.
  const lineup = question.lineup ?? [];
  const result = (outcome: Matched['outcome'], more: Partial<Matched> = {}): Matched => ({
    outcome,
    usage: NO_USAGE,
    note: null,
    ...more,
  });
  const sides = await ports.withDb((db) => matchSides(db, { definition, itemId, entityId }));
  if (sides === null) return result('skipped');
  const recordType = definition.recordTypes[sides.recordType];
  if (recordType === undefined) return result('skipped');
  const pack = recordType.pack === undefined ? undefined : ports.packs[recordType.pack];
  const criteria = pack?.match?.criteria ?? GENERIC_MATCH_CRITERIA;
  const criteriaVersion = pack?.match?.version ?? 0;
  // The entity's editions are facts about it, as its values are, so they are part of the question.
  const state = {
    page: sides.page,
    entity: sides.entity,
    ...(sides.editions.length > 0 ? { editions: sides.editions } : {}),
  };
  const asked = matchQuestion();
  const hash = await stateHash({ question: asked, criteria, state });
  const subject = `${itemId}|${entityId}`;
  const subjectKey = `match:${subject}`;
  const decisionId = await stableId('dc', runId, subjectKey);
  const consent =
    definition.policy.purposes.includes('ai-input') &&
    !(await ports.withDb((db) => anyRefusesAiInput(db, [itemId, ...sides.entityItemIds])));
  const decider = consent ? ports.decider : null;
  const accept = definition.decisions.match.accept;
  const at = ports.now();
  const apply = (decision: DecisionRow) =>
    ports.withDb((db) =>
      applyVerdict(db, { datasetId, itemId, entityId, subject, sides, decision, at }),
    );

  const earlier = await ports.withDb((db) =>
    findDecision(db, { datasetId, subjectKey, stateHash: hash, criteriaVersion }),
  );
  // A question asked before isn't asked again, unless asking might now come to something else.
  if (earlier !== null && stands(earlier, { consent, canAsk: decider !== null, accept })) {
    const waiting = (await apply(earlier)) === 'waiting';
    // A step that runs again finds its own decision, and reports it as it was made.
    const again = earlier.id === decisionId;
    return result(
      waiting ? 'escalated' : again ? 'accepted' : 'reused',
      again
        ? { usage: { inputTokens: earlier.inputTokens, outputTokens: earlier.outputTokens } }
        : {},
    );
  }

  // Asked next run, with a budget of its own; the page waits meanwhile.
  if (decider !== null && budgetLeft <= 0) return result('skipped');
  let outcome: CascadeOutcome;
  try {
    outcome = await cascade({
      request: {
        type: 'match',
        question: asked,
        criteria,
        evidence: matchEvidence({
          recordType,
          page: sides.page,
          entity: sides.entity,
          editions: sides.editions,
          lineup,
        }),
      },
      rule: null,
      deciders: decider === null ? [] : [decider],
      accept,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result('failed', {
      note: storable(`${sides.page.url}: the decider failed on a match question: ${message}`),
    });
  }
  // A decider's join, as the same product or an edition, about a page that is judged to join
  // another entity already contradicts that, whoever gave it: the entities were kept apart, or the
  // page tells them too little apart. It isn't accepted. A person is asked, with the decider's
  // answer proposed.
  if (outcome.by === 'adapter' && matchVerdictOf(outcome.answer) !== 'not_same') {
    const others = (await ports.withDb((db) => sameVerdictsOf(db, itemId))).filter(
      (verdict) => verdict.entityId !== entityId,
    );
    if (others.length > 0) {
      const also = others.length === 1 ? 'another entity' : `${others.length} other entities`;
      outcome = {
        by: 'person',
        adapter: outcome.adapter,
        proposed: outcome.answer,
        probabilities: outcome.probabilities,
        evidence: `${outcome.evidence} The page is judged the same as ${also} already.`,
        usage: outcome.usage,
      };
    }
  }
  // The cascade has no rule for matching yet, so its outcome is a decider's or a person's.
  const usage = outcome.by === 'rule' ? NO_USAGE : outcome.usage;
  // The decision keeps the lineup it showed in its evidence text, since the lineup isn't part of
  // its state.
  const evidence =
    outcome.by === 'rule'
      ? ''
      : [outcome.evidence, lineupNote(lineup)].filter((part) => part !== '').join('\n');
  const decision = await ports.withDb((db) =>
    saveDecision(db, {
      id: decisionId,
      datasetId,
      type: 'match',
      subject,
      subjectKey,
      state,
      stateHash: hash,
      question: asked,
      criteriaVersion,
      adapter: outcome.by === 'rule' ? null : outcome.adapter,
      probabilities: outcome.by === 'rule' ? { [outcome.answer]: 1 } : outcome.probabilities,
      evidence,
      thresholds: { accept },
      outcome: outcome.by === 'adapter' ? 'accepted' : outcome.by === 'rule' ? 'rule' : 'escalated',
      answer: outcome.by === 'person' ? null : outcome.answer,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      decidedAt: at,
    }),
  );
  const waiting = (await apply(decision)) === 'waiting';
  return result(waiting ? 'escalated' : 'accepted', { usage });
}

/**
 * A match decision as a verdict: "same" joins, "edition" joins as an edition, every other answer
 * (another relationship, or the "variant" or "different" of a question from before) keeps the page
 * apart, and no answer yet asks a person. A judgement is as sure as its answer's outcome. A
 * decision that no decider weighed, because none was asked or because its answer fit no schema and
 * named no probabilities, is recorded as the rule's ("rule" means no decider weighed it), so that
 * resolution asks the pair again once one can.
 */
async function applyVerdict(
  db: Executor,
  input: {
    datasetId: string;
    itemId: string;
    entityId: string;
    subject: string;
    sides: { page: { url: string }; entity: { url: string } };
    decision: DecisionRow;
    at: Date;
  },
): Promise<'judged' | 'waiting'> {
  const { datasetId, itemId, entityId, subject, sides, decision, at } = input;
  const answer = decision.finalAnswer ?? decision.answer;
  if (answer === null) {
    const proposed = likeliest(decision.probabilities, optionsOf(decision.question));
    await judge(db, {
      datasetId,
      itemId,
      entityId,
      verdict: 'unsure',
      who: weighed(decision) ? 'llm' : 'rule',
      confidence:
        proposed === null
          ? 0
          : outcomeProbability(decision.question, decision.probabilities, proposed),
      decisionId: decision.id,
      at,
    });
    await openReview(db, {
      id: await stableId('rv', decision.id),
      datasetId,
      kind: 'match',
      subject,
      itemId,
      entityId,
      decisionId: decision.id,
      question: decision.question,
      context: {
        page: sides.page.url,
        // The record's ID, which is how a refusal names it, and the address of the page that
        // stands for the record.
        record: entityId,
        entity: sides.entity.url,
        proposed,
        probabilities: decision.probabilities,
        reason: decision.evidence,
      },
      at,
    });
    return 'waiting';
  }
  await judge(db, {
    datasetId,
    itemId,
    entityId,
    verdict: matchVerdictOf(answer),
    who: decision.finalAnswer !== null ? 'person' : 'llm',
    confidence:
      decision.finalAnswer !== null
        ? 1
        : outcomeProbability(decision.question, decision.probabilities, answer),
    decisionId: decision.id,
    at,
  });
  await dismissReviews(db, { datasetId, kind: 'match', subject, at });
  return 'judged';
}
