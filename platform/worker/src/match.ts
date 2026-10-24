import {
  acceptFor,
  cascade,
  GENERIC_MATCH_CRITERIA,
  lineupNote,
  matchEvidence,
  matchQuestion,
  matchVerdictOf,
  MODEL_NUMBER_REASON,
  modelNumberRule,
  nameField,
  nameScope,
  optionsOf,
  outcomeProbability,
  stableId,
  stateHash,
  type CascadeOutcome,
  type DownMarks,
  type FieldValue,
  type LineupEntry,
  type LlmUsage,
  type ModelCall,
  type RecordType,
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
import { cascadeSteps, noneAsked } from './models';
import { NO_USAGE, type Context, type LlmState, type RefreshPorts } from './pipeline';
import { storable } from './text';

/*
 * One match question (ADR 0003): how is this page related to this entity? The same product, an
 * edition of it, a version whose specifications differ, another model, or an unrelated product.
 * The model-number rule answers first: names that differ only by model marks are other models. It
 * asks no model, so it needs neither AI input nor the budget, and its verdict is the rule's.
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
  outcome: 'rule' | 'accepted' | 'escalated' | 'reused' | 'skipped' | 'failed';
  usage: LlmUsage;
  note: string | null;
  /** What the step asked of models (ADR 0010). Absent in results from before it. */
  calls?: ModelCall[];
  /** The providers the step found down. Absent in results from before it. */
  down?: DownMarks;
  /** The two records' names, when the rule kept them apart in this step. Absent in older results. */
  pair?: string;
}

export async function matchItem(
  context: Context,
  question: { itemId: string; entityId: string; lineup?: readonly LineupEntry[] },
  llm: LlmState,
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
    calls: [],
    down: {},
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
  const canAsk = consent && ports.decider !== null;
  const at = ports.now();
  const rule = ruleFor(recordType, sides);
  const pair = rule === null ? undefined : pairNames(recordType, sides);
  const apply = (decision: DecisionRow) =>
    ports.withDb((db) =>
      applyVerdict(db, { datasetId, itemId, entityId, subject, sides, decision, at }),
    );

  const earlier = await ports.withDb((db) =>
    findDecision(db, { datasetId, subjectKey, stateHash: hash, criteriaVersion }),
  );
  // A question asked before isn't asked again, unless asking might now come to something else.
  if (
    earlier !== null &&
    stands(earlier, {
      consent,
      canAsk,
      accept: acceptFor(definition, 'match', earlier.adapter),
    })
  ) {
    const waiting = (await apply(earlier)) === 'waiting';
    // A step that runs again finds its own decision, and reports it as it was made.
    const again = earlier.id === decisionId;
    const ruled = again && earlier.outcome === 'rule';
    return result(
      waiting ? 'escalated' : ruled ? 'rule' : again ? 'accepted' : 'reused',
      again
        ? {
            usage: { inputTokens: earlier.inputTokens, outputTokens: earlier.outputTokens },
            ...(ruled && pair !== undefined ? { pair } : {}),
          }
        : {},
    );
  }

  // Asked next run, with a budget of its own; the page waits meanwhile. The rule costs nothing.
  if (rule === null && canAsk && llm.usdLeft <= 0) return result('skipped');
  const spent = noneAsked();
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
      rule,
      steps: canAsk ? cascadeSteps({ definition, job: 'match', ports, llm, asked: spent }) : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result('failed', {
      note: storable(`${sides.page.url}: the decider failed on a match question: ${message}`),
      ...spent,
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
        evidence: `${outcome.evidence} The page is judged to join ${also} already.`,
        usage: outcome.usage,
      };
    }
  }
  const usage = outcome.by === 'rule' ? NO_USAGE : outcome.usage;
  // The decision keeps the lineup it showed in its evidence text, since the lineup isn't part of
  // its state. The rule was shown none, and says why it answered. The evidence is one line, since
  // an escalated question shows it as its reason, and the CLI spells a newline out as \u{a}.
  const evidence =
    outcome.by === 'rule'
      ? MODEL_NUMBER_REASON
      : [outcome.evidence, lineupNote(lineup)].filter((part) => part !== '').join(' ');
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
      thresholds: {
        accept: acceptFor(definition, 'match', outcome.by === 'rule' ? null : outcome.adapter),
      },
      outcome: outcome.by === 'adapter' ? 'accepted' : outcome.by === 'rule' ? 'rule' : 'escalated',
      answer: outcome.by === 'person' ? null : outcome.answer,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      decidedAt: at,
    }),
  );
  const waiting = (await apply(decision)) === 'waiting';
  if (outcome.by === 'rule') return result('rule', pair === undefined ? {} : { pair });
  return result(waiting ? 'escalated' : 'accepted', { usage, ...spent });
}

/**
 * A match decision as a verdict: "same" joins, "edition" joins as an edition, every other answer
 * (another relationship, or the "variant" or "different" of a question from before) keeps the page
 * apart, and no answer yet asks a person. A judgement is as sure as its answer's outcome, and the
 * model-number rule's verdict is the rule's. A decision that no decider weighed, because none was
 * asked or because its answer fit no schema and named no probabilities, is recorded as the rule's
 * ("rule" means no decider weighed it), so that resolution asks the pair again once one can.
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
    who: decision.finalAnswer !== null ? 'person' : decision.outcome === 'rule' ? 'rule' : 'llm',
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

/**
 * The model-number rule's answer for the page and the record. It compares the page's name with
 * every name the record carries, its edition pages' included, not only the name its merged side
 * shows, so a record that carries a name the page differs from by more than model marks is left to
 * the decider.
 */
function ruleFor(
  recordType: RecordType,
  sides: {
    page: { values: Record<string, FieldValue[]> };
    entity: { values: Record<string, FieldValue[]> };
    entityNames: readonly string[];
  },
): 'other-model' | null {
  const field = nameField(recordType);
  if (field === null) return null;
  const record = { ...sides.entity.values, [field]: [...sides.entityNames] };
  return modelNumberRule(recordType, sides.page.values, record);
}

/** At most this many characters of each name go into a pair the run's summary names. */
const PAIR_NAME_MAX = 80;

/** The two records' names, as the run's summary names a pair the rule kept apart. */
function pairNames(
  recordType: RecordType,
  sides: {
    page: { values: Record<string, FieldValue[]> };
    entity: { values: Record<string, FieldValue[]> };
  },
): string {
  const name = (values: Record<string, FieldValue[]>) =>
    storable(nameScope(recordType, values)?.name ?? '', PAIR_NAME_MAX);
  return `${name(sides.page.values)} and ${name(sides.entity.values)}`;
}
