import {
  acceptFor,
  adapterName,
  bySortOrder,
  CLASSIFY_CRITERIA_VERSION,
  classifyCriteria,
  classifyQuestion,
  decidedField,
  featuresFor,
  findItem,
  GENERIC_MATCH_CRITERIA,
  hasTaxonomy,
  impliedFunctions,
  isEmptyParts,
  isLive,
  matchEvidence,
  MODEL_NAME,
  NONE_SHELF,
  optionsOf,
  outcomeProbability,
  readAnswerText,
  readFinalAnswer,
  resolveId,
  scoreComparison,
  sharingOutcome,
  stateEvidence,
  TAXONOMY_CRITERIA_VERSION,
  usdOf,
  type AdapterAnswer,
  type ClassifyState,
  type ComparedQuestion,
  type ComparisonReport,
  type DecisionRequest,
  type Definition,
  type DownMarks,
  type FieldDef,
  type LlmUsage,
  type MatchSide,
  type ModelPrice,
  type PackRegistry,
  type Question,
  type Taxonomy,
  type TaxonomyAnswer,
  type TaxonomyDeciderAnswer,
  type TaxonomyParts,
  type TaxonomySubject,
} from '@spatula/core';
import {
  anyRefusesAiInput,
  comparableDecisions,
  currentTaxonomy,
  decisionWithId,
  getDataset,
  matchSides,
  type DecisionRow,
} from '@spatula/store';
import { likeliest } from './classify';
import { portsFor, tryStep, type Tried } from './models';
import type { RefreshPorts, StepRunner } from './pipeline';
import { DatasetMissingError } from './refresh';
import { runTaxonomy, type PlaceState } from './taxonomy';

/*
 * A model comparison (ADR 0010, spec §10): a dataset's answered questions for a job, asked again of
 * a candidate model, and scored against a person's answer or the current model's sure one. It runs
 * as a Workflow of its own: a step that loads the decisions' IDs, one step per question, and a step
 * that writes the report to R2. Each question is rebuilt from its decision's stored state and
 * question with the live step's builders, under the same AI-input consent, and asked through the
 * same steps and backups as a run's (`tryStep`). It fetches no page, and writes nothing to the
 * dataset: no decision, judgement, review, or statement. It spends from its own --max-usd.
 */

export interface CompareParams {
  comparisonId: string;
  datasetId: string;
  job: 'classify' | 'match';
  model: string;
  backup: string | null;
  /** The threshold to score at; null: the job's (with the candidate's step accept, if the definition names it). */
  accept: number | null;
  limit: number;
  maxUsd: number;
  startedAt: string;
}

/** Where a comparison's report is kept. */
export const comparisonKey = (datasetId: string, id: string) =>
  `datasets/${datasetId}/comparisons/${id}.json`;

/** A comparison's ID: its dataset, and when it started, in UTC (ruling 10). */
export const COMPARISON_ID = /^cmp-([a-z0-9][a-z0-9-]*)-(\d{14})$/u;

export function comparisonIdFor(datasetId: string, at: Date): string {
  return `cmp-${datasetId}-${at.toISOString().slice(0, 19).replace(/\D/gu, '')}`;
}

/** The dataset a comparison's ID names, or null for text that isn't one. */
export function datasetOfComparison(id: string): string | null {
  return COMPARISON_ID.exec(id)?.[1] ?? null;
}

/** What the load step keeps: the definition, the taxonomy's version, and the decisions' IDs. */
interface Loaded {
  definition: Definition;
  /** The current taxonomy version, for a dataset whose pages are placed; null otherwise. */
  taxonomyVersion: number | null;
  ids: string[];
}

/** Why a question wasn't asked, as the report's notes count them. */
const SKIPPED = {
  consent: 'the dataset or the page’s site doesn’t allow AI input',
  gone: 'its decision, its page, or its record is gone',
  state: 'its stored state can’t be rebuilt',
  taxonomy: 'it asks about parts the current taxonomy no longer has',
} as const;
type SkipReason = keyof typeof SKIPPED;

/** One question's step: the question scored, or why it was skipped. Kept as JSON by Workflows. */
type Asked =
  | {
      question: ComparedQuestion;
      /** The providers this question found down, which the later questions skip. */
      down: DownMarks;
      /** Why its model and backup failed, when they did. */
      failure?: string;
    }
  | { skipped: SkipReason };

/** Dollars, rounded to a billionth, as a run's spend is. */
const rounded = (usd: number) => Math.round(usd * 1e9) / 1e9;

export async function runComparison(
  params: CompareParams,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<ComparisonReport> {
  const { datasetId, job } = params;
  const loaded = await step.do<Loaded>('load', () =>
    ports.withDb(async (db) => {
      const dataset = await getDataset(db, datasetId);
      if (dataset === null) throw new DatasetMissingError(datasetId);
      const definition = dataset.definition;
      const placing = Object.values(definition.recordTypes).some(hasTaxonomy);
      const taxonomyVersion =
        job === 'classify' && placing
          ? ((await currentTaxonomy(db, datasetId))?.version ?? null)
          : null;
      const rows =
        job === 'classify'
          ? await comparableDecisions(db, {
              datasetId,
              types: ['classify', 'taxonomy'],
              criteriaVersions: {
                classify: CLASSIFY_CRITERIA_VERSION,
                taxonomy: TAXONOMY_CRITERIA_VERSION,
              },
              limit: params.limit,
            })
          : await comparableDecisions(db, {
              datasetId,
              types: ['match'],
              criteriaVersions: { match: matchCriteria(definition, null, ports.packs).version },
              limit: params.limit,
            });
      return { definition, taxonomyVersion, ids: rows.map((row) => row.id) };
    }),
  );
  const { definition } = loaded;
  const accept = params.accept ?? acceptFor(definition, job, adapterName(params.model));
  const placement = job === 'classify' && Object.values(definition.recordTypes).some(hasTaxonomy);

  const results: Asked[] = [];
  let spent = 0;
  let down: DownMarks = {};
  let stoppedAtBudget = false;
  for (const id of loaded.ids) {
    if (rounded(spent) >= params.maxUsd) {
      stoppedAtBudget = true;
      break;
    }
    // Each question gets the providers found down so far, as a copy: a run's later steps skip them.
    const marks = { ...down };
    const asked = await step.do<Asked>(`q:${id}`, () =>
      askAgain({ id, params, loaded, down: marks, ports }),
    );
    results.push(asked);
    if ('question' in asked) {
      spent += asked.question.usd;
      // The first mark for a provider stands.
      down = { ...asked.down, ...down };
    }
  }

  return step.do<ComparisonReport>('report', async () => {
    const questions = results.flatMap((result) => ('question' in result ? [result.question] : []));
    const skipped = results.flatMap((result) => ('skipped' in result ? [result.skipped] : []));
    const scored = scoreComparison({
      questions,
      accept,
      placement,
      floor: definition.decisions[job].accept,
    });
    const report: ComparisonReport = {
      id: params.comparisonId,
      dataset: datasetId,
      job,
      model: params.model,
      backup: params.backup,
      accept,
      startedAt: params.startedAt,
      finishedAt: ports.now().toISOString(),
      skipped: skipped.length,
      stoppedAtBudget,
      ...scored,
      notes: notesFor({
        job,
        found: loaded.ids.length,
        results,
        skipped,
        stoppedAtBudget,
        maxUsd: params.maxUsd,
        given: questions.filter((question) => question.givenShelf === true).length,
      }),
    };
    await ports.blobs.put(
      comparisonKey(datasetId, params.comparisonId),
      JSON.stringify(report),
      'application/json',
    );
    return report;
  });
}

/** The report's notes: what kept questions from being asked, and what the candidate wasn't shown. */
function notesFor(input: {
  job: CompareParams['job'];
  found: number;
  results: readonly Asked[];
  skipped: readonly SkipReason[];
  stoppedAtBudget: boolean;
  maxUsd: number;
  /** The placements that were given their shelf. */
  given: number;
}): string[] {
  const notes: string[] = [];
  if (input.found === 0) {
    notes.push('The dataset has no answered questions for this job under the current criteria.');
  }
  if (input.job === 'match') {
    notes.push(
      'Match questions are asked without the lineup of the brand’s other records, which a decision doesn’t keep: the candidate saw less than the current model did.',
    );
  }
  for (const reason of Object.keys(SKIPPED) as SkipReason[]) {
    const count = input.skipped.filter((skipped) => skipped === reason).length;
    if (count > 0) notes.push(`${count} skipped: ${SKIPPED[reason]}.`);
  }
  const failures = input.results.flatMap((result) =>
    'failure' in result && result.failure !== undefined ? [result.failure] : [],
  );
  if (failures.length > 0) {
    notes.push(`${failures.length} failed on the model and its backup. The first: ${failures[0]}`);
  }
  if (input.given > 0) {
    notes.push(`${input.given} placements were given their shelf, so their shelf counts as right.`);
  }
  if (input.stoppedAtBudget) {
    const unasked = input.found - input.results.length;
    notes.push(`It stopped at $${input.maxUsd}, with ${unasked} questions not asked.`);
  }
  return notes;
}

/** The match criteria and their version: those of the record type's pack, or the generic ones. */
function matchCriteria(
  definition: Definition,
  recordTypeName: string | null,
  packs: PackRegistry,
): { criteria: string; version: number } {
  const recordType =
    recordTypeName === null
      ? Object.values(definition.recordTypes)[0]
      : definition.recordTypes[recordTypeName];
  const pack = recordType?.pack === undefined ? undefined : packs[recordType.pack];
  return {
    criteria: pack?.match?.criteria ?? GENERIC_MATCH_CRITERIA,
    version: pack?.match?.version ?? 0,
  };
}

/** What the current decision cost, at the price of the model its adapter names; null when unknown. */
function currentUsdOf(
  decision: DecisionRow,
  price: (model: string) => ModelPrice | null,
): number | null {
  const prefix = adapterName('');
  if (decision.adapter === null || !decision.adapter.startsWith(prefix)) return null;
  const model = decision.adapter.slice(prefix.length);
  // A decision from before ADR 0010 names no provider (`llm:claude-opus-5-5`). Every decider then
  // was Anthropic's Claude, so its bare name is priced as Anthropic's.
  const named = MODEL_NAME.test(model) ? model : model.includes('/') ? null : `anthropic/${model}`;
  if (named === null) return null;
  const unit = price(named);
  return unit === null ? null : usdOf(decision, unit);
}

/** The asking of one question: the candidate's step, timed and priced. */
async function asking<T>(
  input: { params: CompareParams; down: DownMarks; ports: RefreshPorts },
  ask: (model: string) => Promise<{ value: T; usage: LlmUsage }>,
): Promise<{ tried: Tried<T>; usd: number; ms: number }> {
  const { params, ports } = input;
  const started = ports.now().getTime();
  const tried = await tryStep({
    step: { model: params.model, backup: params.backup, accept: null },
    setup: ports.models,
    down: input.down,
    now: ports.now(),
    ask,
  });
  const ms = Math.max(0, ports.now().getTime() - started);
  // A failed call counts no tokens; a model with no price counts no dollars.
  const usd = tried.calls.reduce((total, call) => {
    const unit = ports.models.price(call.model);
    return unit === null ? total : total + usdOf(call, unit);
  }, 0);
  return { tried, usd, ms };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function isClassifyState(value: unknown): value is ClassifyState {
  return (
    isObject(value) &&
    typeof value.url === 'string' &&
    (value.title === null || typeof value.title === 'string') &&
    isStrings(value.breadcrumbs) &&
    isStrings(value.types) &&
    isStrings(value.categories) &&
    isObject(value.values) &&
    Object.values(value.values).every(isStrings)
  );
}

const isSide = (value: unknown): value is MatchSide =>
  isObject(value) &&
  typeof value.url === 'string' &&
  isObject(value.values) &&
  Object.values(value.values).every((values) => Array.isArray(values));

function isParts(value: unknown): value is TaxonomyParts {
  return (
    isObject(value) &&
    isStrings(value.shelves) &&
    isStrings(value.functions) &&
    isObject(value.features) &&
    Object.values(value.features).every(isStrings)
  );
}

/**
 * A stored classification state as `classifyState` built it, its values' properties sorted again:
 * Postgres keeps a JSON object's keys in an order of its own, and the evidence lists them in order.
 */
function asBuilt(state: ClassifyState): ClassifyState {
  const values = Object.keys(state.values)
    .sort()
    .map((name) => [name, state.values[name]!] as const);
  return { ...state, values: Object.fromEntries(values) };
}

/**
 * A placement's asked parts as `askedParts` built them, the features in the taxonomy's order again,
 * for the same reason: the request lists them in order.
 */
function partsAsBuilt(taxonomy: Taxonomy, asked: TaxonomyParts): TaxonomyParts {
  const order = taxonomy.features.filter(isLive).sort(bySortOrder);
  const rank = new Map(order.map((feature, index) => [feature.id, index]));
  const features = Object.keys(asked.features)
    .sort((a, b) => (rank.get(a) ?? rank.size) - (rank.get(b) ?? rank.size))
    .map((feature) => [feature, asked.features[feature]!] as const);
  return { ...asked, features: Object.fromEntries(features) };
}

/**
 * Asks one decision's question again. It reads only: the decision, the page's consent, the
 * taxonomy, and for a match the record's pages. Its answer goes nowhere but the report.
 */
async function askAgain(input: {
  id: string;
  params: CompareParams;
  loaded: Loaded;
  down: DownMarks;
  ports: RefreshPorts;
}): Promise<Asked> {
  const { id, loaded, ports } = input;
  const { definition } = loaded;
  const decision = await ports.withDb((db) => decisionWithId(db, id));
  if (decision === null) return { skipped: 'gone' };
  if (!definition.policy.purposes.includes('ai-input')) return { skipped: 'consent' };
  const column: ComparedQuestion['column'] = decision.finalAnswer !== null ? 'person' : 'model';
  const currentUsd = currentUsdOf(decision, ports.models.price);
  if (decision.type === 'taxonomy') return askPlacement(input, decision, column, currentUsd);

  const question = decision.question as Question;
  if (question.type !== 'choice') return { skipped: 'state' };
  const expected = decision.finalAnswer ?? decision.answer;
  if (expected === null) return { skipped: 'state' };
  let request: DecisionRequest;
  let subject: string;
  if (decision.type === 'classify') {
    const state = decision.state;
    const field = classifiedField(definition, question);
    if (!isClassifyState(state) || field === null) return { skipped: 'state' };
    // The same consent as the live step: the site's signals at the page's latest fetch.
    if (await ports.withDb((db) => anyRefusesAiInput(db, [decision.subject]))) {
      return { skipped: 'consent' };
    }
    request = {
      type: 'classify',
      question,
      criteria: classifyCriteria(field),
      evidence: stateEvidence(asBuilt(state)),
    };
    subject = state.url;
  } else if (decision.type === 'match') {
    const state = decision.state;
    if (!isObject(state) || !isSide(state.page) || !isSide(state.entity)) {
      return { skipped: 'state' };
    }
    const editions = state.editions ?? [];
    if (!isStrings(editions)) return { skipped: 'state' };
    const [itemId, entityId] = decision.subject.split('|');
    if (itemId === undefined || entityId === undefined) return { skipped: 'state' };
    const sides = await ports.withDb((db) => matchSides(db, { definition, itemId, entityId }));
    const recordType = sides === null ? undefined : definition.recordTypes[sides.recordType];
    if (sides === null || recordType === undefined) return { skipped: 'gone' };
    // The same consent as the live step: every side's site, at each page's latest fetch.
    const refused = await ports.withDb((db) =>
      anyRefusesAiInput(db, [itemId, ...sides.entityItemIds]),
    );
    if (refused) return { skipped: 'consent' };
    request = {
      type: 'match',
      question,
      criteria: matchCriteria(definition, sides.recordType, ports.packs).criteria,
      // A decision doesn't keep the lineup it was shown, so none is shown (ruling 8).
      evidence: matchEvidence({
        recordType,
        page: state.page,
        entity: state.entity,
        editions,
        lineup: [],
      }),
    };
    subject = `${state.page.url} | ${state.entity.url}`;
  } else {
    return { skipped: 'state' };
  }

  const { tried, usd, ms } = await asking<AdapterAnswer>(input, async (model) => {
    const decider = portsFor(ports, model).decider;
    if (decider === null) throw new Error('no decider is configured');
    const answer = await decider.decide(request);
    return { value: answer, usage: answer.usage };
  });
  const base = { decisionId: decision.id, subject, column, usd, currentUsd, ms, expected };
  if (tried.answered === null) {
    return failed(base, tried);
  }
  const options = optionsOf(question);
  const probabilities = offered(tried.answered.value.probabilities, options);
  const best = likeliest(probabilities, options);
  // Right by option, or for a match by outcome: another relationship that keeps the page apart
  // is as right as the one given.
  const right = best !== null && sharingOutcome(question, expected).includes(best);
  return {
    question: {
      ...base,
      failed: false,
      right,
      allRight: right,
      sureness: best === null ? 0 : outcomeProbability(question, probabilities, best),
      answered: best ?? '(no answer)',
    },
    down: tried.down,
  };
}

/** A question whose model and backup both failed: it counts, at no cost, as failed. */
function failed(
  base: Omit<ComparedQuestion, 'failed' | 'right' | 'allRight' | 'sureness' | 'answered'>,
  tried: Tried<unknown>,
): Asked {
  return {
    question: {
      ...base,
      failed: true,
      right: false,
      allRight: false,
      sureness: 0,
      answered: '(failed)',
    },
    down: tried.down,
    failure: tried.failures.join('; '),
  };
}

/** The probabilities a decider named for offered answers, each above 0 and at most 1, as the cascade takes them. */
function offered(given: Record<string, number>, options: readonly string[]) {
  const allowed = new Set(options);
  return Object.fromEntries(
    Object.entries(given).filter(
      ([option, chance]) =>
        allowed.has(option) && Number.isFinite(chance) && chance > 0 && chance <= 1,
    ),
  );
}

/** The decided field a classify question was asked for: the record type's whose question it is. */
function classifiedField(definition: Definition, question: Question): FieldDef | null {
  for (const recordType of Object.values(definition.recordTypes)) {
    const decided = decidedField(recordType);
    if (decided !== null && classifyQuestion(...decided).prompt === question.prompt) {
      return decided[1];
    }
  }
  return null;
}

/** Whether an ID names a live item of the taxonomy: not retired, and not merged into another. */
const live = (taxonomy: Taxonomy, subject: TaxonomySubject, itemId: string) =>
  resolveId(taxonomy, subject, itemId) === itemId;

/** Whether everything a placement asked about is live in the taxonomy. */
function allLive(taxonomy: Taxonomy, parts: TaxonomyParts): boolean {
  return (
    parts.shelves.every((shelf) => shelf === NONE_SHELF || live(taxonomy, 'shelf', shelf)) &&
    parts.functions.every((fn) => live(taxonomy, 'function', fn)) &&
    Object.entries(parts.features).every(
      ([feature, values]) =>
        live(taxonomy, 'feature', feature) &&
        values.every((value) => live(taxonomy, 'value', value)),
    )
  );
}

/** An answer's parts as they stand in the taxonomy now: merged items as the ones they went into. */
function inTaxonomy(taxonomy: Taxonomy, answer: TaxonomyAnswer): TaxonomyAnswer | null {
  const shelf =
    answer.shelf === null || answer.shelf === NONE_SHELF
      ? answer.shelf
      : resolveId(taxonomy, 'shelf', answer.shelf);
  if (shelf === null) return null;
  const resolved = (subject: TaxonomySubject, ids: readonly string[]) =>
    ids.flatMap((itemId) => {
      const now = resolveId(taxonomy, subject, itemId);
      return now === null ? [] : [now];
    });
  return {
    shelf,
    functions: resolved('function', answer.functions),
    values: resolved('value', answer.values),
  };
}

/** The offered ID with the highest chance above 0; a tie goes to the one offered first. */
function likeliestId(ids: readonly string[], chances: Record<string, number>): string | null {
  let best: string | null = null;
  for (const itemId of ids) {
    const chance = chances[itemId] ?? 0;
    if (chance > 0 && (best === null || chance > (chances[best] ?? 0))) best = itemId;
  }
  return best;
}

/**
 * The candidate's likeliest placement, as a person's question would propose it: the likeliest
 * shelf asked (or the one it was given), the functions beyond those the shelf implies that it
 * gives at least even odds, and the values of its shelf's features that it gives at least even
 * odds (for a feature of one value, the likeliest). With it, how sure it is: the least sure of the
 * parts it was asked (a part's sureness is max(p, 1 − p), the shelf's is its own chance).
 */
function candidatePlacement(
  taxonomy: Taxonomy,
  asked: TaxonomyParts,
  given: string | null,
  answer: TaxonomyDeciderAnswer,
): { placed: TaxonomyAnswer; sureness: number } {
  const { shelves, functions, values } = answer.probabilities;
  const chance = (record: Record<string, number>, itemId: string) => record[itemId] ?? 0;
  const sure = (p: number) => Math.max(p, 1 - p);
  const shelf = asked.shelves.length > 0 ? likeliestId(asked.shelves, shelves) : given;
  const sureness: number[] =
    asked.shelves.length > 0 ? [shelf === null ? 0 : chance(shelves, shelf)] : [];
  if (shelf === null || shelf === NONE_SHELF) {
    return { placed: { shelf, functions: [], values: [] }, sureness: Math.min(...sureness, 1) };
  }
  const implied = new Set(impliedFunctions(taxonomy, shelf));
  const placedFunctions: string[] = [];
  for (const fn of asked.functions) {
    if (implied.has(fn)) continue;
    sureness.push(sure(chance(functions, fn)));
    if (chance(functions, fn) >= 0.5) placedFunctions.push(fn);
  }
  const placedValues: string[] = [];
  for (const feature of featuresFor(taxonomy, shelf)) {
    const offeredValues = asked.features[feature.id];
    if (offeredValues === undefined) continue;
    for (const value of offeredValues) sureness.push(sure(chance(values, value)));
    if (feature.cardinality === 'one') {
      const top = likeliestId(offeredValues, values);
      if (top !== null && chance(values, top) >= 0.5) placedValues.push(top);
    } else {
      placedValues.push(...offeredValues.filter((value) => chance(values, value) >= 0.5));
    }
  }
  return {
    placed: { shelf, functions: placedFunctions, values: placedValues },
    sureness: Math.min(...sureness, 1),
  };
}

/**
 * Whether a placement is right in every part it was asked: the shelf, each function beyond those
 * the shelf implies, and each value of the shelf's features.
 */
function rightInEveryPart(
  taxonomy: Taxonomy,
  asked: TaxonomyParts,
  placed: TaxonomyAnswer,
  expected: TaxonomyAnswer,
): boolean {
  if (placed.shelf !== expected.shelf) return false;
  const shelf = expected.shelf;
  if (shelf === null || shelf === NONE_SHELF) return true;
  const implied = new Set(impliedFunctions(taxonomy, shelf));
  const functionsRight = asked.functions
    .filter((fn) => !implied.has(fn))
    .every((fn) => placed.functions.includes(fn) === expected.functions.includes(fn));
  const valuesRight = featuresFor(taxonomy, shelf)
    .flatMap((feature) => asked.features[feature.id] ?? [])
    .every((value) => placed.values.includes(value) === expected.values.includes(value));
  return functionsRight && valuesRight;
}

/** A placement in words, by slug: "headphone-amps; functions: dac; values: headphones". */
function placementText(taxonomy: Taxonomy, answer: TaxonomyAnswer): string {
  if (answer.shelf === NONE_SHELF) return NONE_SHELF;
  const slugs = (subject: TaxonomySubject, ids: readonly string[]) =>
    ids.map((itemId) => findItem(taxonomy, subject, itemId)?.slug ?? itemId).sort();
  return [
    answer.shelf === null ? '(no shelf)' : slugs('shelf', [answer.shelf])[0]!,
    ...(answer.functions.length > 0
      ? [`functions: ${slugs('function', answer.functions).join(', ')}`]
      : []),
    ...(answer.values.length > 0 ? [`values: ${slugs('value', answer.values).join(', ')}`] : []),
  ].join('; ');
}

/**
 * Asks a shelf placement again, as the live step asked it, in the current taxonomy: what the
 * decider was asked (`asked`), and when that didn't include the shelf, the shelf it was given. A
 * placement that asked about parts the taxonomy no longer has, or was given a shelf it no longer
 * has, is skipped. It is scored for the shelf (`right`), and for every part (`allRight`).
 */
async function askPlacement(
  input: Parameters<typeof askAgain>[0],
  decision: DecisionRow,
  column: ComparedQuestion['column'],
  currentUsd: number | null,
): Promise<Asked> {
  const { loaded, ports } = input;
  const state = decision.state as Partial<PlaceState>;
  if (!isObject(state) || !isClassifyState(state.page) || !isParts(state.asked)) {
    return { skipped: 'state' };
  }
  const { page } = state;
  // The shelf the live step gave the decider when it didn't ask one: a person's standing shelf, or
  // else a rule's (`state.rule` keeps only the rule's). Its answer starts from that shelf, so the
  // decision's own answer names it, and never a person's later one.
  const given =
    state.asked.shelves.length === 0 ? (readAnswerText(decision.answer)?.shelf ?? null) : null;
  if (isEmptyParts(state.asked) || (state.asked.shelves.length === 0 && given === null)) {
    return { skipped: 'state' };
  }
  if (loaded.taxonomyVersion === null) return { skipped: 'taxonomy' };
  const taxonomy = await runTaxonomy(
    { datasetId: input.params.datasetId, taxonomyVersion: loaded.taxonomyVersion },
    ports,
  );
  if (taxonomy === null) return { skipped: 'taxonomy' };
  if (!allLive(taxonomy, state.asked) || (given !== null && !live(taxonomy, 'shelf', given))) {
    return { skipped: 'taxonomy' };
  }
  const asked = partsAsBuilt(taxonomy, state.asked);
  const read =
    decision.finalAnswer !== null
      ? (readFinalAnswer(decision.finalAnswer)?.answer ?? null)
      : readAnswerText(decision.answer);
  const expected = read === null ? null : inTaxonomy(taxonomy, read);
  if (expected === null) return { skipped: 'taxonomy' };
  // The same consent as the live step: the site's signals at the page's latest fetch.
  if (await ports.withDb((db) => anyRefusesAiInput(db, [decision.subject]))) {
    return { skipped: 'consent' };
  }

  const evidence = stateEvidence(asBuilt(page));
  const { tried, usd, ms } = await asking<TaxonomyDeciderAnswer>(input, async (model) => {
    const decider = portsFor(ports, model).taxonomyDecider;
    if (decider === null) throw new Error('no decider is configured');
    const answer = await decider.decide({ taxonomy, parts: asked, shelf: given, evidence });
    return { value: answer, usage: answer.usage };
  });
  const base = {
    decisionId: decision.id,
    subject: page.url,
    column,
    usd,
    currentUsd,
    ...(given === null ? {} : { givenShelf: true }),
    ms,
    expected: placementText(taxonomy, expected),
  };
  if (tried.answered === null) return failed(base, tried);
  const { placed, sureness } = candidatePlacement(taxonomy, asked, given, tried.answered.value);
  return {
    question: {
      ...base,
      failed: false,
      right: placed.shelf === expected.shelf,
      allRight: rightInEveryPart(taxonomy, asked, placed, expected),
      sureness,
      answered: placementText(taxonomy, placed),
    },
    down: tried.down,
  };
}
