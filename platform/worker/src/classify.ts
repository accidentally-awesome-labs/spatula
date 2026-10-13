import {
  cascade,
  CLASSIFY_CRITERIA_VERSION,
  classifyCriteria,
  classifyQuestion,
  classifyRule,
  classifyState,
  decidedField,
  NONE_OF_THESE,
  parsePage,
  stableId,
  stateEvidence,
  stateHash,
  survivingValues,
  type CascadeOutcome,
  type ContentSignals,
  type Definition,
  type FieldDef,
  type LlmUsage,
  type Method,
  type RecordType,
  type Source,
  type StatementInput,
} from '@spatula/core';
import {
  dismissReviews,
  findDecision,
  openReview,
  saveDecision,
  setExtractedWith,
  setItemStatus,
  statementsOf,
  writeStatements,
  type DecisionRow,
  type Executor,
  type ItemRef,
} from '@spatula/store';
import {
  extractionTag,
  NO_USAGE,
  pageKey,
  retryTag,
  type Context,
  type RefreshPorts,
} from './pipeline';
import { storable } from './text';

/*
 * Classifying a page (ADR 0003): which value of its record type's decided field the page's one
 * product has, or "None of these", which takes the page out of the dataset. A rule answers when
 * every product the page's structured data describes states the same category, one of the values.
 * Otherwise the decider answers, where the dataset and the site allow AI input and the run has
 * budget left, and a person answers what the decider isn't sure of. A question asked before, on the
 * same evidence, isn't asked again, and a person's answer stands until a person changes it.
 */

/** The methods of the cascade's own statements: a rule's answer, and a decider's. */
export const CASCADE_METHODS = ['rule', 'llm'] as const;

/** The record type's decided field, when the source leaves it to the cascade; null otherwise. */
export function cascadeField(source: Source, recordType: RecordType): [string, FieldDef] | null {
  const decided = decidedField(recordType);
  if (decided === null) return null;
  const [name] = decided;
  return Object.hasOwn(source.fixed, name) || Object.hasOwn(source.extract, name) ? null : decided;
}

export interface ClassifyTarget {
  name: string;
  field: FieldDef;
  recordType: RecordType;
}

/** What the cascade classifies on an item's page, or null when its source says it already. */
export function classifyTarget(definition: Definition, item: ItemRef): ClassifyTarget | null {
  const source = definition.sources.find((candidate) => candidate.id === item.sourceId);
  const recordType = definition.recordTypes[item.recordType];
  if (source === undefined || recordType === undefined) return null;
  const decided = cascadeField(source, recordType);
  return decided === null ? null : { name: decided[0], field: decided[1], recordType };
}

/** The answer with the highest probability, or null when there is none. */
export function likeliest(probabilities: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [answer, probability] of Object.entries(probabilities)) {
    if (best === null || probability > (probabilities[best] ?? 0)) best = answer;
  }
  return best;
}

export interface Classified {
  outcome: 'rule' | 'accepted' | 'escalated' | 'reused' | 'skipped' | 'failed';
  /** Whether the answer took the page out of the dataset. */
  irrelevant: boolean;
  usage: LlmUsage;
  note: string | null;
}

/** The page's fetch, as classifying needs it. */
export interface ClassifyFetch {
  fetchId: string;
  contentHash: string | null;
  finalUrl: string;
  signals: ContentSignals;
}

/** How a recorded decision was made, as a run counts it. */
const madeBy = (decision: DecisionRow): Classified['outcome'] =>
  decision.outcome === 'rule' ? 'rule' : decision.outcome === 'accepted' ? 'accepted' : 'escalated';

/**
 * Classifies a page, and with that finishes reading it. The extract step leaves a page whose
 * category the cascade decides marked for another read, and a classification that finished,
 * whoever answered and whatever the answer, makes it current. A step that stopped short of that,
 * because the decider failed, the run's budget was spent, or something threw, leaves the page to
 * the next run. So does an extraction that stopped short, which `extractionComplete` says: the LLM
 * step failed or waited for the budget, and classifying the page doesn't change that.
 */
export async function classifyItem(
  context: Context,
  item: ItemRef,
  fetched: ClassifyFetch,
  budgetLeft: number,
  ports: RefreshPorts,
  extractionComplete = true,
): Promise<Classified> {
  const classified = await classifyPage(context, item, fetched, budgetLeft, ports);
  if (extractionComplete && classified.outcome !== 'skipped' && classified.outcome !== 'failed') {
    await ports.withDb((db) => setExtractedWith(db, item.id, extractionTag(context.revision)));
  }
  return classified;
}

async function classifyPage(
  context: Context,
  item: ItemRef,
  fetched: ClassifyFetch,
  budgetLeft: number,
  ports: RefreshPorts,
): Promise<Classified> {
  const { datasetId, definition, runId } = context;
  const target = classifyTarget(definition, item);
  if (target === null) throw new Error(`${item.locator} has nothing for the cascade to classify`);
  const { name, field, recordType } = target;
  const result = (outcome: Classified['outcome'], more: Partial<Classified> = {}): Classified => ({
    outcome,
    irrelevant: false,
    usage: NO_USAGE,
    note: null,
    ...more,
  });

  const said = await ports.withDb(
    async (db) => (await statementsOf(db, [item.id])).get(item.id) ?? [],
  );
  // A person's answer stands until a person changes it.
  if (said.some((statement) => statement.property === name && statement.method === 'human')) {
    return result('reused');
  }
  const body =
    fetched.contentHash === null ? null : await ports.blobs.get(pageKey(fetched.contentHash));
  if (body === null) throw new Error(`The stored copy of ${item.locator} is missing`);
  const page = parsePage(new TextDecoder().decode(body), fetched.finalUrl);
  const values = survivingValues(recordType, said);
  delete values[name];
  const state = classifyState(page, values);
  const question = classifyQuestion(name, field);
  const criteria = classifyCriteria(field);
  // The question and its criteria are part of the hash, so a change to the field's values, or to
  // their description, asks again.
  const hash = await stateHash({ question, criteria, state });
  const subjectKey = `classify:${item.id}`;
  const decisionId = await stableId('dc', runId, subjectKey);
  const consent =
    definition.policy.purposes.includes('ai-input') && fetched.signals['ai-input'] !== 'no';
  const at = ports.now();
  const apply = (decision: DecisionRow) =>
    ports.withDb((db) =>
      applyClassification(db, { datasetId, item, name, fetchId: fetched.fetchId, decision, at }),
    );

  const earlier = await ports.withDb((db) =>
    findDecision(db, {
      datasetId,
      subjectKey,
      stateHash: hash,
      criteriaVersion: CLASSIFY_CRITERIA_VERSION,
    }),
  );
  // A decider's answer is used again only while the dataset and the site still allow AI input.
  if (earlier !== null && (earlier.outcome !== 'accepted' || consent)) {
    const applied = await apply(earlier);
    // A step that runs again finds its own decision, and reports it as it was made.
    const again = earlier.id === decisionId;
    return result(applied === 'waiting' ? 'escalated' : again ? madeBy(earlier) : 'reused', {
      irrelevant: applied === 'irrelevant',
      usage: again
        ? { inputTokens: earlier.inputTokens, outputTokens: earlier.outputTokens }
        : NO_USAGE,
    });
  }

  const rule = classifyRule(state, field);
  const decider = consent ? ports.decider : null;
  if (rule === null && decider !== null && budgetLeft <= 0) {
    // The next run reads the page again, with a budget of its own.
    await ports.withDb((db) => setExtractedWith(db, item.id, retryTag(context.revision)));
    return result('skipped');
  }
  let outcome: CascadeOutcome;
  try {
    outcome = await cascade({
      request: {
        type: 'classify',
        question,
        criteria,
        evidence: stateEvidence(state),
      },
      rule,
      deciders: decider === null ? [] : [decider],
      accept: definition.decisions.classify.accept,
    });
  } catch (error) {
    await ports.withDb((db) => setExtractedWith(db, item.id, retryTag(context.revision)));
    const message = error instanceof Error ? error.message : String(error);
    return result('failed', { note: storable(`${item.locator}: the decider failed: ${message}`) });
  }
  const usage = outcome.by === 'rule' ? NO_USAGE : outcome.usage;
  const decision = await ports.withDb((db) =>
    saveDecision(db, {
      id: decisionId,
      datasetId,
      type: 'classify',
      subject: item.id,
      subjectKey,
      state,
      stateHash: hash,
      question,
      criteriaVersion: CLASSIFY_CRITERIA_VERSION,
      adapter: outcome.by === 'rule' ? null : outcome.adapter,
      probabilities: outcome.by === 'rule' ? { [outcome.answer]: 1 } : outcome.probabilities,
      evidence:
        outcome.by === 'rule'
          ? 'The page’s structured data gives this category.'
          : outcome.evidence,
      thresholds: { accept: definition.decisions.classify.accept },
      outcome: outcome.by === 'rule' ? 'rule' : outcome.by === 'adapter' ? 'accepted' : 'escalated',
      answer: outcome.by === 'person' ? null : outcome.answer,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      decidedAt: at,
    }),
  );
  const applied = await apply(decision);
  return result(madeBy(decision), { irrelevant: applied === 'irrelevant', usage });
}

/**
 * Applies a classification. An answer becomes a statement whose path names the decision; "None of
 * these" takes the page out; no answer yet asks a person, and the automatic answer is withdrawn
 * meanwhile, so the record waits rather than carrying a guess.
 */
async function applyClassification(
  db: Executor,
  input: {
    datasetId: string;
    item: ItemRef;
    name: string;
    fetchId: string;
    decision: DecisionRow;
    at: Date;
  },
): Promise<'answered' | 'irrelevant' | 'waiting'> {
  const { datasetId, item, name, fetchId, decision, at } = input;
  const write = { datasetId, itemId: item.id, fetchId, seenAt: at, properties: [name] };
  const withdrawAutomatic = () =>
    writeStatements(db, { ...write, methods: CASCADE_METHODS, statements: [] });
  const answer = decision.finalAnswer ?? decision.answer;
  if (answer === null) {
    await withdrawAutomatic();
    await openReview(db, {
      id: await stableId('rv', decision.id),
      datasetId,
      kind: 'classify',
      subject: item.id,
      itemId: item.id,
      decisionId: decision.id,
      question: decision.question,
      context: {
        url: item.locator,
        // The field a person's answer fills, so that answering needn't work it out.
        field: name,
        proposed: likeliest(decision.probabilities),
        probabilities: decision.probabilities,
        reason: decision.evidence,
      },
      at,
    });
    return 'waiting';
  }
  await dismissReviews(db, { datasetId, kind: 'classify', subject: item.id, at });
  if (answer === NONE_OF_THESE) {
    await withdrawAutomatic();
    await setItemStatus(db, item.id, 'irrelevant');
    return 'irrelevant';
  }
  const method: Method =
    decision.finalAnswer !== null ? 'human' : decision.outcome === 'rule' ? 'rule' : 'llm';
  const statement: StatementInput = {
    property: name,
    value: answer,
    valueKey: answer,
    original: answer,
    method,
    path: `decision:${decision.id}`,
    confidence: method === 'llm' ? (decision.probabilities[answer] ?? 0) : 1,
    position: null,
  };
  if (method === 'human') {
    await withdrawAutomatic();
    await writeStatements(db, { ...write, methods: ['human'], statements: [statement] });
  } else {
    await writeStatements(db, { ...write, methods: CASCADE_METHODS, statements: [statement] });
  }
  return 'answered';
}
