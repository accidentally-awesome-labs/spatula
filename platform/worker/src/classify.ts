import {
  cascade,
  CLASSIFY_CRITERIA_VERSION,
  classifyCriteria,
  classifyQuestion,
  classifyRule,
  classifyState,
  decidedField,
  NONE_OF_THESE,
  optionsOf,
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
 * same evidence, isn't asked again unless asking might now come to something else: its answer is
 * less sure than the dataset now asks for, or no decider could be asked then and one can be now. A
 * person's answer stands until a person changes it.
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

/**
 * Whether the page's decided field holds a decider's answer: its current statement has the method
 * llm. A rule's answer and a person's don't rest on AI input.
 */
export async function decidedByLlm(
  context: Context,
  item: ItemRef,
  ports: RefreshPorts,
): Promise<boolean> {
  const target = classifyTarget(context.definition, item);
  if (target === null) return false;
  const said = await ports.withDb((db) => statementsOf(db, [item.id]));
  return (said.get(item.id) ?? []).some(
    (statement) => statement.property === target.name && statement.method === 'llm',
  );
}

/**
 * The offered answer with the highest probability, or null when there is none. A tie goes to the
 * option offered first, as it does in the cascade, so the answer a person is shown doesn't depend
 * on the order Postgres hands the probabilities back in.
 */
export function likeliest(
  probabilities: Record<string, number>,
  options: readonly string[],
): string | null {
  let best: string | null = null;
  for (const option of options) {
    const probability = probabilities[option];
    if (!Object.hasOwn(probabilities, option) || probability === undefined) continue;
    if (best === null || probability > (probabilities[best] ?? 0)) best = option;
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
 * Whether an earlier decision on the same evidence still answers the question. A rule's answer
 * does, and so does a person's. A decider's answer does while the dataset and the site allow AI
 * input and the answer is as sure as the dataset now asks. An escalation a decider weighed does:
 * asking again would put the same question to it. One that no decider weighed does only while none
 * can be asked: an escalation made when none was asked, or one whose decider named no
 * probabilities, as it does when its answer doesn't fit the schema.
 */
export function stands(
  earlier: DecisionRow,
  now: { consent: boolean; canAsk: boolean; accept: number },
): boolean {
  if (earlier.finalAnswer !== null || earlier.outcome === 'rule') return true;
  if (earlier.outcome === 'accepted') {
    const probability = earlier.answer === null ? 0 : (earlier.probabilities[earlier.answer] ?? 0);
    return now.consent && probability >= now.accept;
  }
  const weighed = earlier.adapter !== null && Object.keys(earlier.probabilities).length > 0;
  return weighed || !now.canAsk;
}

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
  extractionComplete: boolean,
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
  // A person's answer stands until a person changes it, and replaces the cascade's, which is
  // withdrawn here if it is still current. That changes nothing once it has been.
  if (said.some((statement) => statement.property === name && statement.method === 'human')) {
    await ports.withDb((db) =>
      withdrawCascade(db, {
        datasetId,
        itemId: item.id,
        name,
        fetchId: fetched.fetchId,
        at: ports.now(),
      }),
    );
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
  const decider = consent ? ports.decider : null;
  const accept = definition.decisions.classify.accept;
  // Extraction marked the page for another read already; this keeps classifyItem safe on its own.
  const readAgain = () =>
    ports.withDb((db) => setExtractedWith(db, item.id, retryTag(context.revision)));
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
  // A question asked before isn't asked again, unless asking might now come to something else.
  if (earlier !== null && stands(earlier, { consent, canAsk: decider !== null, accept })) {
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
  if (rule === null && decider !== null && budgetLeft <= 0) {
    // The next run reads the page again, with a budget of its own.
    await readAgain();
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
      accept,
    });
  } catch (error) {
    await readAgain();
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
      thresholds: { accept },
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

/** Withdraws the cascade's own statements about the decided field: a rule's and a decider's. */
function withdrawCascade(
  db: Executor,
  input: { datasetId: string; itemId: string; name: string; fetchId: string; at: Date },
) {
  const { datasetId, itemId, name, fetchId, at } = input;
  return writeStatements(db, {
    datasetId,
    itemId,
    fetchId,
    seenAt: at,
    properties: [name],
    methods: CASCADE_METHODS,
    statements: [],
  });
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
    withdrawCascade(db, { datasetId, itemId: item.id, name, fetchId, at });
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
        proposed: likeliest(decision.probabilities, optionsOf(decision.question)),
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
