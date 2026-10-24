import {
  acceptFor,
  acceptParts,
  answerText,
  applyRule,
  askedParts,
  carriedOver,
  classifyState,
  emptyParts,
  findItem,
  flatProbabilities,
  freshen,
  hasTaxonomy,
  isEmptyParts,
  jobSteps,
  NONE_SHELF,
  noProbabilities,
  nothingCarried,
  orderedShelves,
  parsePage,
  readFinalAnswer,
  resolveId,
  ruleShelf,
  splitProbabilities,
  stableId,
  standingShelf,
  stateEvidence,
  stateHash,
  stepAccept,
  subcategoriesOf,
  survivingValues,
  TAXONOMY_CRITERIA_VERSION,
  TAXONOMY_FIELDS,
  TAXONOMY_PROMPT,
  taxonomyKey,
  type ClassifyState,
  type Definition,
  type Method,
  type Page,
  type PartsDecision,
  type RecordType,
  type Source,
  type StatementInput,
  type Taxonomy,
  type TaxonomyAnswer,
  type TaxonomyParts,
  type TaxonomyProbabilities,
} from '@spatula/core';
import {
  decisionById,
  dismissReviews,
  findDecision,
  latestFinalized,
  openReview,
  saveDecision,
  setExtractedWith,
  setItemStatus,
  setTaxonomyKey,
  statementsOf,
  taxonomyAt,
  writeStatements,
  type DecisionRow,
  type Executor,
  type ItemRef,
} from '@spatula/store';
import { readPageBody } from './captures';
import { CASCADE_METHODS, madeBy, weighed, type Classified, type ClassifyFetch } from './classify';
import { gather, noneAsked, portsFor, savedCalls, tryStep } from './models';
import {
  extractionTag,
  NO_USAGE,
  retryTag,
  type Context,
  type LlmState,
  type RefreshPorts,
} from './pipeline';
import { storable } from './text';

/*
 * Placing a page in its dataset's taxonomy (ADR 0007): one question in three parts, its shelf, the
 * functions beyond those the shelf implies, and the values of the features on the shelf. A person's
 * shelf, then a rule's, settles the shelf part. The classify job's steps are asked the rest, in
 * order, where the dataset and the site allow AI input and the run has budget left (ADR 0010): a
 * step whose answer leaves a part open passes the whole question to the next, and a person is asked
 * only the parts the last step isn't sure of, in one question, and only once every step weighed it.
 * A decision is found again by the page's state, the rule's shelf, and the taxonomy key of the shelf
 * it put the page on, so a change to the taxonomy asks a page again only when it touches what the
 * page's question covered. Each settled part is a statement; an unknown shelf leaves the record
 * out, and "None of these" takes the page out of the dataset.
 */

/** What deciding reads of a page: what a capture keeps of it, and the text its source's shelf rule finds. */
export interface PageFacts {
  page: Pick<Page, 'url' | 'title' | 'breadcrumbs' | 'jsonLd'>;
  /** The text `extract.shelf` finds; absent when the source declares no such rule. */
  extracted?: string | null;
}

export interface TaxonomyTarget {
  recordType: RecordType;
  source: Source;
}

/** A place decision's state. Its hash covers all but `asked`, which re-reading the decision needs. */
export interface PlaceState {
  page: ClassifyState;
  /** The shelf a rule names, or null. */
  rule: string | null;
  /** The hash of the taxonomy key of the shelf the decision puts the page on. */
  key: string;
  /** What the decider was asked. */
  asked: TaxonomyParts;
}

/** A place decision's subject key: one current decision per page. */
export const placeSubject = (itemId: string) => `taxonomy:${itemId}`;

/** A taxonomy key's hash, which a page keeps and a decision's state holds. */
export const keyHash = (taxonomy: Taxonomy, shelfId: string | null) =>
  stateHash(taxonomyKey(taxonomy, shelfId));

/** A place decision's hash: the page's state, the rule's shelf, and the key. */
export const placeHash = (state: Pick<PlaceState, 'page' | 'rule' | 'key'>) =>
  stateHash({ page: state.page, rule: state.rule, key: state.key });

/** What placing an item needs, or null when its record type has no taxonomy. */
export function taxonomyTarget(definition: Definition, item: ItemRef): TaxonomyTarget | null {
  const source = definition.sources.find((candidate) => candidate.id === item.sourceId);
  const recordType = definition.recordTypes[item.recordType];
  if (source === undefined || recordType === undefined || !hasTaxonomy(recordType)) return null;
  return { recordType, source };
}

/** The taxonomies this isolate has read, by dataset and version. A version is never rewritten. */
const read = new Map<string, Taxonomy>();
const READ_MAX = 20;

/** The taxonomy version the run started with, or null when the dataset has none yet. */
export async function runTaxonomy(
  context: Pick<Context, 'datasetId' | 'taxonomyVersion'>,
  ports: Pick<RefreshPorts, 'withDb'>,
): Promise<Taxonomy | null> {
  const version = context.taxonomyVersion;
  if (version === undefined || version === null) return null;
  const key = `${context.datasetId}@${version}`;
  const known = read.get(key);
  if (known !== undefined) return known;
  const row = await ports.withDb((db) => taxonomyAt(db, context.datasetId, version));
  if (row === null) throw new Error(`${context.datasetId} has no taxonomy version ${version}`);
  if (read.size >= READ_MAX) read.delete(read.keys().next().value!);
  read.set(key, row.taxonomy);
  return row.taxonomy;
}

/** What deciding reads of a page that was parsed whole. */
export function factsOf(source: Source, page: Page): PageFacts {
  const rule = source.extract.shelf;
  return rule === undefined ? { page } : { page, extracted: applyRule(page, rule) };
}

type Part = 'shelf' | 'functions' | 'features';
const SUBJECT_OF = { shelf: 'shelf', functions: 'function', features: 'value' } as const;

/**
 * An answer's parts as statements whose path names the decision: the shelf unless it's left out
 * (`shelf: null`), each function, and each feature value, each by its ID, with its slug as what
 * was said.
 */
export function partStatements(
  taxonomy: Taxonomy,
  answer: TaxonomyAnswer,
  how: {
    shelf: Method | null;
    parts: Method;
    confidence(property: Part, itemId: string): number;
    path: string;
  },
): StatementInput[] {
  const statement = (property: Part, itemId: string, method: Method): StatementInput => ({
    property,
    value: itemId,
    valueKey: itemId,
    original: findItem(taxonomy, SUBJECT_OF[property], itemId)?.slug ?? itemId,
    method,
    path: how.path,
    confidence: Math.min(1, Math.max(0, how.confidence(property, itemId))),
    position: null,
  });
  const shelf = answer.shelf;
  return [
    ...(how.shelf === null || shelf === null || shelf === NONE_SHELF
      ? []
      : [statement('shelf', shelf, how.shelf)]),
    ...answer.functions.map((fn) => statement('functions', fn, how.parts)),
    ...answer.values.map((value) => statement('features', value, how.parts)),
  ];
}

/**
 * Whether an earlier decision about a page's place still answers. A person's does. One a decider
 * weighed does while the dataset and the site allow AI input. One no decider weighed does while none
 * can be asked, or when it asked a decider nothing anyway.
 */
export function placeStands(
  earlier: DecisionRow,
  now: { consent: boolean; canAsk: boolean },
): boolean {
  if (earlier.finalAnswer !== null) return true;
  if (weighed(earlier)) return now.consent;
  const asked = (earlier.state as Partial<PlaceState>).asked;
  return !now.canAsk || (asked !== undefined && isEmptyParts(asked));
}

/** What a person last said about a page, read as a taxonomy answer, or null when they said nothing. */
async function lastAnswer(
  context: Pick<Context, 'datasetId'>,
  item: ItemRef,
  ports: Pick<RefreshPorts, 'withDb'>,
): Promise<ReturnType<typeof readFinalAnswer>> {
  const row = await ports.withDb((db) =>
    latestFinalized(db, { datasetId: context.datasetId, subject: item.id }),
  );
  return readFinalAnswer(row?.finalAnswer ?? null);
}

const isNone = (answer: ReturnType<typeof readFinalAnswer>) => answer?.answer.shelf === NONE_SHELF;

/**
 * Whether a person took the page out: their latest answer about it is "None of these", whether a
 * classification kept it before the taxonomy or a place decision did (ruling 7). It stays out until
 * a person answers again.
 */
export async function saidNone(
  context: Pick<Context, 'datasetId'>,
  item: ItemRef,
  ports: Pick<RefreshPorts, 'withDb'>,
): Promise<boolean> {
  return isNone(await lastAnswer(context, item, ports));
}

/**
 * Whether a person took the page out (`saidNone`), and if so, makes it irrelevant. A page that is
 * live again, as a revived one is, goes back out here, so placing it as an irrelevant page
 * (`irrelevant`) keeps it out and reopens their question when the decider finds it a shelf, rather
 * than publishing it with the decider's.
 */
export async function keepOut(
  context: Pick<Context, 'datasetId'>,
  item: ItemRef,
  ports: Pick<RefreshPorts, 'withDb'>,
): Promise<boolean> {
  if (!(await saidNone(context, item, ports))) return false;
  await ports.withDb((db) => setItemStatus(db, item.id, 'irrelevant'));
  return true;
}

/** A person's answer that can't carry over, which reopens the question, showing it (ruling 7). */
interface Reopen {
  earlier: TaxonomyAnswer;
  /** Whether the page stays out of the dataset until the person answers: their "None of these". */
  keepOut: boolean;
}

/**
 * Places a page, and with that finishes reading it, as classifying does (classify.ts): a decision
 * that finished, whoever made it, makes the page current, unless its extraction stopped short. A
 * backfill places a page without reading it (`extractionComplete: false`), from what its capture
 * keeps (`facts`), and an irrelevant page as one (`irrelevant`).
 */
export async function decideTaxonomy(
  context: Context,
  item: ItemRef,
  fetched: ClassifyFetch,
  llm: LlmState,
  ports: RefreshPorts,
  options: { extractionComplete: boolean; facts?: PageFacts; irrelevant?: boolean },
): Promise<Classified> {
  const placed = await placePage(context, item, fetched, llm, ports, options);
  if (options.extractionComplete && placed.outcome !== 'skipped' && placed.outcome !== 'failed') {
    await ports.withDb((db) => setExtractedWith(db, item.id, extractionTag(context.revision)));
  }
  return placed;
}

async function placePage(
  context: Context,
  item: ItemRef,
  fetched: ClassifyFetch,
  llm: LlmState,
  ports: RefreshPorts,
  options: { facts?: PageFacts; irrelevant?: boolean },
): Promise<Classified> {
  const { datasetId, definition, runId } = context;
  const target = taxonomyTarget(definition, item);
  if (target === null) throw new Error(`${item.locator} has no taxonomy to be placed in`);
  const taxonomy = await runTaxonomy(context, ports);
  if (taxonomy === null)
    throw new Error(`${datasetId} has no taxonomy to place ${item.locator} in`);
  const result = (outcome: Classified['outcome'], more: Partial<Classified> = {}): Classified => ({
    outcome,
    irrelevant: false,
    usage: NO_USAGE,
    note: null,
    calls: [],
    down: {},
    ...more,
  });

  const said = await ports.withDb(
    async (db) => (await statementsOf(db, [item.id])).get(item.id) ?? [],
  );
  const facts = options.facts ?? factsOf(target.source, await storedPage(ports, item, fetched));
  // The taxonomy's fields aren't the record type's, so the state holds the page's own values only.
  const state = classifyState(facts.page, survivingValues(target.recordType, said));
  const rule = ruleShelf(taxonomy, {
    ...(Object.hasOwn(target.source.fixed, 'shelf') ? { fixed: target.source.fixed.shelf } : {}),
    ...(facts.extracted === undefined ? {} : { extracted: facts.extracted }),
    state,
  });
  const standing = standingShelf(taxonomy, said);
  const last = await lastAnswer(context, item, ports);
  const personNone = isNone(last);
  const reopen: Reopen | null =
    standing.retired !== null
      ? {
          earlier:
            last !== null && last.answer.shelf === standing.retired
              ? last.answer
              : { shelf: standing.retired, functions: [], values: [] },
          keepOut: false,
        }
      : options.irrelevant === true && personNone && last !== null
        ? { earlier: last.answer, keepOut: true }
        : null;
  const personShelf = standing.byPerson ? standing.shelf : null;
  const fixedShelf = personShelf ?? rule.shelf;
  // A person's "None of these" says nothing of the functions and features they were shown.
  const carried = personNone ? nothingCarried() : carriedOver(taxonomy, last, fixedShelf);
  const asked = askedParts(taxonomy, fixedShelf, carried);

  const subjectKey = placeSubject(item.id);
  const decisionId = await stableId('dc', runId, subjectKey);
  const consent =
    definition.policy.purposes.includes('ai-input') && fetched.signals['ai-input'] !== 'no';
  const canAsk = consent && ports.taxonomyDecider !== null;
  const at = ports.now();
  const seenAt = fetched.seenAt === undefined ? at : new Date(fetched.seenAt);
  const readAgain = () =>
    ports.withDb((db) => setExtractedWith(db, item.id, retryTag(context.revision)));
  const apply = (decision: DecisionRow) =>
    ports.withDb((db) =>
      applyPlace(db, {
        taxonomy,
        datasetId,
        item,
        fetched,
        decision,
        personShelf,
        reopen,
        irrelevant: options.irrelevant === true,
        // Each answer is held to the threshold of the step that gave it (ADR 0010).
        accept: acceptFor(definition, 'classify', decision.adapter),
        seenAt,
        at,
      }),
    );

  // The page's decision under the key of the shelf it stands on. A step that runs again finds its
  // own by ID first: its statements may have moved the page's key since.
  const lookup = await placeHash({
    page: state,
    rule: rule.shelf,
    key: await keyHash(taxonomy, standing.shelf),
  });
  const earlier = await ports.withDb(
    async (db) =>
      (await decisionById(db, decisionId)) ??
      findDecision(db, {
        datasetId,
        subjectKey,
        stateHash: lookup,
        criteriaVersion: TAXONOMY_CRITERIA_VERSION,
      }),
  );
  if (
    earlier !== null &&
    (earlier.id === decisionId || placeStands(earlier, { consent, canAsk }))
  ) {
    const applied = await apply(earlier);
    const again = earlier.id === decisionId;
    return result(applied === 'waiting' ? 'escalated' : again ? madeBy(earlier) : 'reused', {
      irrelevant: applied === 'irrelevant',
      usage: again
        ? { inputTokens: earlier.inputTokens, outputTokens: earlier.outputTokens }
        : NO_USAGE,
      ...(again ? { calls: savedCalls(earlier) } : {}),
    });
  }

  const asking = canAsk && !isEmptyParts(asked);
  if (asking && llm.usdLeft <= 0) {
    // The next run reads the page again, with a budget of its own.
    await readAgain();
    return result('skipped');
  }
  let probabilities: TaxonomyProbabilities = noProbabilities();
  let reason =
    personShelf !== null
      ? 'A person chose the shelf.'
      : rule.shelf !== null
        ? 'A rule names the shelf.'
        : 'No decider could be asked.';
  let usage = NO_USAGE;
  let adapter: string | null = null;
  let accept = definition.decisions.classify.accept;
  const gathered = noneAsked();
  if (asking) {
    const failures: string[] = [];
    let settled = false;
    const evidence = stateEvidence(state);
    for (const step of jobSteps(definition, 'classify', ports.models.defaultModel)) {
      const tried = await tryStep({
        step,
        setup: ports.models,
        down: { ...llm.down, ...gathered.down },
        now: ports.now(),
        async ask(model) {
          const decider = portsFor(ports, model).taxonomyDecider;
          if (decider === null) throw new Error('no decider is configured');
          const answer = await decider.decide({
            taxonomy,
            parts: asked,
            shelf: fixedShelf,
            evidence,
          });
          return { value: { answer, adapter: decider.name }, usage: answer.usage };
        },
      });
      gather(gathered, tried);
      if (tried.answered === null) {
        failures.push(...tried.failures);
        continue;
      }
      // Each step's answer is taken whole, on its own threshold (ADR 0010).
      const { answer } = tried.answered.value;
      probabilities = answer.probabilities;
      reason = answer.evidence;
      usage = {
        inputTokens: usage.inputTokens + answer.usage.inputTokens,
        outputTokens: usage.outputTokens + answer.usage.outputTokens,
      };
      adapter = tried.answered.value.adapter;
      accept = stepAccept(definition, 'classify', step);
      const placed = acceptParts({ taxonomy, asked, fixedShelf, probabilities, accept });
      if (isEmptyParts(placed.open)) {
        settled = true;
        break;
      }
    }
    // A person is asked only what every step weighed (ADR 0003).
    if (!settled && failures.length > 0) {
      await readAgain();
      return result('failed', {
        note: storable(`${item.locator}: the decider failed: ${failures.join('; ')}`),
        ...gathered,
      });
    }
  }
  const decided = acceptParts({ taxonomy, asked, fixedShelf, probabilities, accept });
  const placeState: PlaceState = {
    page: state,
    rule: rule.shelf,
    key: await keyHash(taxonomy, decided.settled.shelf),
    asked,
  };
  const stateHashOf = await placeHash(placeState);
  const settledAll = isEmptyParts(decided.open);
  const decision = await ports.withDb((db) =>
    saveDecision(db, {
      id: decisionId,
      datasetId,
      type: 'taxonomy',
      subject: item.id,
      subjectKey,
      state: placeState,
      stateHash: stateHashOf,
      question: { type: 'taxonomy', prompt: TAXONOMY_PROMPT, parts: decided.open },
      criteriaVersion: TAXONOMY_CRITERIA_VERSION,
      adapter,
      probabilities: flatProbabilities(probabilities),
      evidence: reason,
      thresholds: { accept },
      outcome: !settledAll ? 'escalated' : adapter === null ? 'rule' : 'accepted',
      answer: answerText(decided.settled),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      decidedAt: at,
    }),
  );
  const applied = await apply(decision);
  return result(applied === 'waiting' ? 'escalated' : madeBy(decision), {
    irrelevant: applied === 'irrelevant',
    usage,
    note: rule.note === null ? null : storable(`${item.locator}: ${rule.note}`),
    ...gathered,
  });
}

/** The page as its stored copy reads, parsed whole, so a selector can run on it. */
async function storedPage(
  ports: RefreshPorts,
  item: ItemRef,
  fetched: ClassifyFetch,
): Promise<Page> {
  const body =
    fetched.contentHash === null ? null : await readPageBody(ports.blobs, fetched.contentHash);
  if (body === null) throw new Error(`The stored copy of ${item.locator} is missing`);
  return parsePage(new TextDecoder().decode(body), fetched.finalUrl);
}

/** The settled shelf's probability; for a category the page fell back to, its family's together. */
function shelfChance(
  taxonomy: Taxonomy,
  chances: TaxonomyProbabilities,
  placement: PartsDecision,
  accept: number,
): number {
  const shelf = placement.settled.shelf;
  if (shelf === null) return accept;
  if (!placement.fallback) return chances.shelves[shelf] ?? accept;
  return [shelf, ...subcategoriesOf(taxonomy, shelf).map((sub) => sub.id)].reduce(
    (sum, member) => sum + (chances.shelves[member] ?? 0),
    0,
  );
}

/**
 * Applies a decision about a page's place. A person's decision is applied as they gave it, as their
 * statements. Any other is accepted again, under the threshold its step has now (the job's, for a
 * rule's) and this taxonomy version, and its settled parts are the cascade's statements: a rule's
 * shelf as the rule's, the rest as the decider's. A shelf a person chose isn't stated by the
 * cascade. "None of these" takes the page out. The parts left open are a person's one question, and
 * so is a person's earlier answer that can't carry over. The page keeps the key its decision was
 * made under.
 */
async function applyPlace(
  db: Executor,
  input: {
    taxonomy: Taxonomy;
    datasetId: string;
    item: ItemRef;
    fetched: ClassifyFetch;
    decision: DecisionRow;
    personShelf: string | null;
    reopen: Reopen | null;
    irrelevant: boolean;
    accept: number;
    seenAt: Date;
    at: Date;
  },
): Promise<'answered' | 'irrelevant' | 'waiting'> {
  const { taxonomy, datasetId, item, fetched, decision, personShelf, reopen, accept, at } = input;
  const write = {
    datasetId,
    itemId: item.id,
    fetchId: fetched.fetchId,
    seenAt: input.seenAt,
    captureId: fetched.captureId ?? null,
  };
  const path = `decision:${decision.id}`;
  const final = readFinalAnswer(decision.finalAnswer);
  const state = decision.state as Partial<PlaceState>;
  const chances = splitProbabilities(decision.probabilities);
  const placement: PartsDecision =
    final !== null
      ? { settled: final.answer, open: emptyParts(), proposed: final.answer, fallback: false }
      : freshen(
          taxonomy,
          acceptParts({
            taxonomy,
            asked: state.asked ?? emptyParts(),
            fixedShelf: personShelf ?? state.rule ?? null,
            probabilities: chances,
            accept,
          }),
        );
  const none = placement.settled.shelf === NONE_SHELF;

  if (final !== null) {
    await writeStatements(db, {
      ...write,
      methods: CASCADE_METHODS,
      properties: TAXONOMY_FIELDS,
      statements: [],
    });
    await writeStatements(db, {
      ...write,
      methods: ['human'],
      properties: TAXONOMY_FIELDS,
      statements: none
        ? []
        : partStatements(taxonomy, final.answer, {
            shelf: 'human',
            parts: 'human',
            confidence: () => 1,
            path,
          }),
    });
  } else {
    if (personShelf !== null) {
      await writeStatements(db, {
        ...write,
        methods: CASCADE_METHODS,
        properties: ['shelf'],
        statements: [],
      });
    }
    const shelfMethod: Method =
      state.rule !== undefined && state.rule !== null && placement.settled.shelf === state.rule
        ? 'rule'
        : 'llm';
    await writeStatements(db, {
      ...write,
      methods: CASCADE_METHODS,
      properties: personShelf === null ? TAXONOMY_FIELDS : ['functions', 'features'],
      statements: none
        ? []
        : partStatements(taxonomy, placement.settled, {
            shelf: personShelf === null ? shelfMethod : null,
            parts: 'llm',
            confidence: (property, itemId) =>
              property === 'shelf'
                ? shelfMethod === 'rule'
                  ? 1
                  : shelfChance(taxonomy, chances, placement, accept)
                : property === 'functions'
                  ? (chances.functions[itemId] ?? accept)
                  : (chances.values[itemId] ?? accept),
            path,
          }),
    });
  }

  const asks = !isEmptyParts(placement.open) || (reopen !== null && !(reopen.keepOut && none));
  if (none) {
    if (!input.irrelevant) await setItemStatus(db, item.id, 'irrelevant');
  } else if (input.irrelevant && reopen?.keepOut !== true) {
    // A page the decider took out, and that it now places or isn't sure of, comes back.
    await setItemStatus(db, item.id, 'live');
  }
  if (asks) {
    // A reopened question asks the shelf again, whatever the decider settled meanwhile.
    const open =
      reopen === null || placement.open.shelves.length > 0
        ? placement.open
        : {
            ...placement.open,
            shelves: [...orderedShelves(taxonomy).map((shelf) => shelf.id), NONE_SHELF],
          };
    await openReview(db, {
      id: await stableId('rv', decision.id),
      datasetId,
      kind: 'classify',
      subject: item.id,
      itemId: item.id,
      decisionId: decision.id,
      question: { type: 'taxonomy', prompt: TAXONOMY_PROMPT, parts: open },
      context: {
        url: item.locator,
        // The answer's fields: the review API places the page by them.
        field: 'taxonomy',
        version: taxonomy.version,
        proposed: placement.proposed,
        settled: placement.settled,
        probabilities: decision.probabilities,
        reason: decision.evidence,
        captureId: fetched.captureId ?? null,
        ...(reopen === null ? {} : { earlier: reopen.earlier }),
      },
      at,
    });
  } else {
    await dismissReviews(db, { datasetId, kind: 'classify', subject: item.id, at });
  }
  const shelf = placement.settled.shelf;
  await setTaxonomyKey(
    db,
    item.id,
    await keyHash(
      taxonomy,
      shelf === null || shelf === NONE_SHELF ? shelf : resolveId(taxonomy, 'shelf', shelf),
    ),
  );
  return none ? 'irrelevant' : asks ? 'waiting' : 'answered';
}
