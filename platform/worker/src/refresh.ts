import {
  acceptLlmOutput,
  buildLlmRequest,
  extractFromPage,
  LLM_MAX_TOKENS,
  llmFields,
  llmInputHash,
  MAX_MATCH_QUESTIONS,
  PAGE_METHODS,
  parsePage,
  pathPatternMatches,
  REFUSE_AFTER_RUNS,
  sha256Hex,
  sourceVerdict,
  stableId,
  type ContentSignals,
  type Definition,
  type LlmUsage,
  type Outcome,
  type Page,
  type PageExtraction,
  type RecordType,
  type RunSummary,
  type SiteAnswer,
  type SourceProbe,
  type SourceVerdict,
} from '@spatula/core';
import {
  dueItems,
  finishRun,
  getDataset,
  itemsByIds,
  liveAgain,
  probeItem,
  recordExtraction,
  recordFetch,
  recordSourceRuns,
  reseeStatements,
  resolveEntities,
  sourceStates,
  startRun,
  writeStatements,
  type FetchInput,
  type ItemRef,
  type StatementCounts,
} from '@spatula/store';
import { cascadeField, classifyItem, classifyTarget, decidedByLlm } from './classify';
import { discoverSource } from './discovery';
import { matchItem } from './match';
import {
  budgetLeft,
  decisionsOf,
  extractionTag,
  intervalFor,
  NO_CHANGE,
  NO_USAGE,
  pageKey,
  retryTag,
  type Context,
  type RefreshPorts,
  type Standing,
  type StepRunner,
} from './pipeline';
import { publish } from './publish';
import { isChallenge, MAX_WAITS, requestThroughGate, siteAnswerOf, type Resume } from './requests';
import { storable } from './text';

// What other modules have always imported from here.
export {
  extractionTag,
  pageKey,
  snapshotKey,
  type BlobPort,
  type GatePort,
  type HttpPort,
  type HttpResult,
  type RefreshPorts,
  type StepRunner,
} from './pipeline';

/*
 * One refresh of one dataset. A sitemap source's sitemaps are read first (discovery.ts), which
 * lists its pages. Each page is fetched in its own step, through the gate, and only a
 * page that changed (or whose statements came from older code) is extracted, in a step of its
 * own, from the copy kept under its hash. A failed or blocked fetch changes no values. The LLM is
 * asked only for fields nothing else filled, only where the dataset and the site allow AI input,
 * and only when its question changed. A page whose source leaves the record type's decided field
 * to the cascade is then classified, in a step of its own (classify.ts), and isn't current until
 * that step has finished. The LLM and the decider share the run's token budget (pipeline.ts). Then
 * entities are resolved. Resolution asks about the pairs it can't settle by rule, each in a step
 * of its own (match.ts), and defers them until they're answered. If the records changed, they go
 * through the dataset's gates (publish.ts): a snapshot is published when the gates allow it, and
 * held for the owner's review when they don't. Nothing here imports Cloudflare: the Workflow
 * passes real ports, and the tests pass fakes. A source that refused three runs in a row gets only
 * a probe; a step after the pages counts each source's standing (ADR 0006).
 */

export interface RefreshParams {
  runId: string;
  datasetId: string;
  /** Treat every live page as due, however recently it was read. The budget still applies. */
  all?: boolean;
}

export const MAX_NOTES = 50;
/**
 * The most statements one page's extraction may yield. writeStatements inserts them in one
 * statement, 15 parameters to a row, and postgres.js refuses a statement with 65,534 parameters
 * or more. The cap also bounds the lists of IDs that writing re-sees and withdraws, and what
 * survivorship reads. An honest product page says a few dozen things.
 */
export const MAX_PAGE_STATEMENTS = 1_000;
/**
 * How many pages one step loads for the run. A step's result is kept as JSON and capped at 1 MiB, so
 * the pages load in steps of 50 rather than all at once.
 */
const ITEMS_PER_STEP = 50;
/**
 * Pages in a row from one source, each blocked or straining its host, that pause the rest of the
 * source's pages for this run. A block here is the host's: a 401, 402, or 403 it answered with, or
 * a challenge. A strain is a 429 or a 5xx it answered with, or no answer to a request the gate let
 * go: the network dropped it, it timed out, or the HTTP client wouldn't send it. The gate records
 * each strain and lengthens the host's break, and the run sleeps through it before its next page,
 * on whatever host, so a host that strains on every page would hold up every other one. Anything
 * else starts the count again: a page the gate turns away, or that the run gave up waiting to ask
 * for, sent no request and lengthened no break; and any other answer, a failure such as "not
 * HTML" included, shows the host answering. Challenges come with requests close together, so the
 * source rests until the next run, and its pages stay due. Across runs, its blocked runs are
 * counted (ADR 0006).
 */
export const SOURCE_PAUSE_AFTER = 3;

export class DatasetMissingError extends Error {
  constructor(datasetId: string) {
    super(`Dataset ${datasetId} doesn’t exist`);
    this.name = 'DatasetMissingError';
  }
}

/** What a final answer means. A page that arrived is then changed or unchanged by its hash. */
export function classifyResponse(response: {
  status: number;
  headers: Record<string, string>;
  truncated: boolean;
}): { kind: 'page' } | { kind: 'final'; outcome: Outcome; error: string | null } {
  const { status, headers } = response;
  const final = (outcome: Outcome, error: string | null) => ({
    kind: 'final' as const,
    outcome,
    error,
  });
  if (status === 304) return final('unchanged', null);
  if (isChallenge(headers)) return final('blocked', 'the site answered with a challenge');
  // A lone 429 is a busy host, not a refusal: it fails the fetch, and the gate backs off.
  if ([401, 402, 403].includes(status)) return final('blocked', `HTTP ${status}`);
  if (status === 404 || status === 410) return final('gone', `HTTP ${status}`);
  if (status < 200 || status >= 300) return final('failed', `HTTP ${status}`);
  const type = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'text/html' && type !== 'application/xhtml+xml') {
    return final('failed', `not HTML (${type === '' ? 'no content type' : type})`);
  }
  if (response.truncated) return final('failed', 'larger than 5 MB');
  return { kind: 'page' };
}

/** A fetch's result, as its step returns it. */
interface Fetched {
  fetchId: string;
  outcome: Outcome;
  /**
   * Whether the host answered, so its status decided the outcome. False for a gate refusal, such as
   * a page robots.txt disallows, and for a request that got no answer: the network dropped it, or
   * the run gave up waiting to send it. A `blocked` outcome without an answer is Spatula's, not
   * the host's.
   */
  hostAnswered: boolean;
  /**
   * Whether the fetch strained the host: it answered 429 or a 5xx, or no answer came to a request
   * the gate let go. A result kept by an earlier version has none, which reads as no strain.
   */
  strained?: boolean;
  /**
   * What the answer says of the site (ADR 0006): Spatula got through, or was refused. A result
   * kept by an earlier version has none, which reads as neither, as an outage does.
   */
  site?: SiteAnswer | null;
  finalUrl: string;
  signals: ContentSignals;
  /** The page the statements will come from: the fresh one, or the one stored before. */
  contentHash: string | null;
  /** Whether to extract: the page changed, or its statements came from older code. */
  extract: boolean;
  reseen: number;
  note: string | null;
}

interface Extracted {
  statements: StatementCounts;
  llm: 'ran' | 'reused' | 'skipped' | 'failed';
  usage: LlmUsage;
  notes: string[];
  /** Whether the page was read: a page that couldn't be has nothing to classify. */
  read: boolean;
  /** Whether the LLM wasn't asked because the run's budget was spent. */
  waitsForBudget: boolean;
}

/** What the load step returns. One kept by an earlier version has no standing. */
interface Loaded {
  revision: number;
  definition: Definition;
  startedAt: string;
  standing?: Record<string, Standing>;
}

export async function runRefresh(
  params: RefreshParams,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<RunSummary> {
  const { runId, datasetId } = params;
  try {
    const loaded = await step.do<Loaded>('load', () =>
      ports.withDb(async (db) => {
        const dataset = await getDataset(db, datasetId);
        if (dataset === null) throw new DatasetMissingError(datasetId);
        await startRun(db, { id: runId, datasetId });
        // The run's own time, for what's due and for what its sitemaps list. A step that runs again
        // returns its first result, so every later step sees the same time.
        return {
          revision: dataset.revision,
          definition: dataset.definition,
          startedAt: ports.now().toISOString(),
          // Each source's standing as the run starts (ADR 0006): it sets the source's pacing, and
          // whether the run only probes it.
          standing: Object.fromEntries(
            (await sourceStates(db, datasetId)).map((state) => [
              state.id,
              { blockedRuns: state.blockedRuns, refused: state.refusedAt !== null },
            ]),
          ),
        };
      }),
    );
    const context: Context = {
      runId,
      datasetId,
      revision: loaded.revision,
      definition: loaded.definition,
      startedAt: new Date(loaded.startedAt),
      standing: loaded.standing ?? {},
    };
    const summary = emptySummary();

    // What each source's answers said of its site, and what each refused source's probe met (ADR
    // 0006). Both come from steps' results, so a run that replays its steps counts the same.
    const answers = new Map<string, (SiteAnswer | null)[]>();
    const heard = (sourceId: string, site: SiteAnswer | null) => {
      const list = answers.get(sourceId);
      if (list === undefined) answers.set(sourceId, [site]);
      else list.push(site);
    };
    const probed = new Map<string, SiteAnswer | null>();
    const isRefused = (sourceId: string) => context.standing?.[sourceId]?.refused === true;

    for (const source of context.definition.sources) {
      if (source.kind !== 'sitemap') continue;
      const probe = isRefused(source.id);
      const found = await discoverSource(context, source, step, ports, { probe });
      for (const site of found.sites) heard(source.id, site);
      if (probe) probed.set(source.id, found.sites[0] ?? null);
      const discovery = summary.discovery!;
      discovery.sources += 1;
      discovery.sitemaps += found.sitemaps;
      discovery.listed += found.listed;
      discovery.added += found.added;
      discovery.revived += found.revived;
      discovery.missing += found.missing;
      discovery.gone += found.gone;
      if (found.incomplete !== null) {
        discovery.incomplete.push(storable(`${source.id}: ${found.incomplete}`));
      }
      for (const text of found.notes) note(summary, text);
    }

    // The pages that wait for the next run because the run's LLM budget is spent, a probe's included.
    let budgetWaits = 0;
    // A refused pages source is probed with its least recently read page.
    const probedPages = new Set<string>();
    for (const source of context.definition.sources) {
      if (source.kind !== 'pages' || !isRefused(source.id)) continue;
      const item = await step.do(`probe:${source.id}`, () =>
        ports.withDb((db) => probeItem(db, { datasetId, sourceId: source.id })),
      );
      if (item === null) continue;
      probedPages.add(item.id);
      const refreshed = await refreshItem(context, item, summary, step, ports);
      summary.items += 1;
      heard(source.id, refreshed.site);
      probed.set(source.id, refreshed.site);
      if (refreshed.waitsForBudget) budgetWaits += 1;
    }
    // A probe that got through makes its source live again before the plan, so this run reads its
    // due pages.
    const back = [...probed].filter(([, site]) => site === 'through').map(([id]) => id);
    if (back.length > 0) {
      await step.do('sources:back', () =>
        ports.withDb((db) => liveAgain(db, { datasetId, sourceIds: back })),
      );
    }

    const plan = await step.do('plan', () =>
      ports.withDb((db) =>
        dueItems(db, {
          datasetId,
          now: context.startedAt,
          maxAgeDays: context.definition.freshness.maxAgeDays,
          current: extractionTag(context.revision),
          limit: context.definition.budget.itemsPerRun,
          all: params.all === true,
        }),
      ),
    );
    summary.live = plan.live;
    const waiting = plan.due - plan.ids.length;
    if (waiting > 0) {
      const { itemsPerRun } = context.definition.budget;
      const budget = `the budget reads ${itemsPerRun} ${itemsPerRun === 1 ? 'page' : 'pages'} a run`;
      // Under --all every live page is due, and the next ordinary run reads only the pages whose
      // freshness has run out, which may be none of these. So they aren't said to wait for it.
      note(
        summary,
        params.all === true
          ? `${waiting} live ${waiting === 1 ? 'page wasn’t' : 'pages weren’t'} read: ${budget}`
          : `${waiting} due ${waiting === 1 ? 'page waits' : 'pages wait'} for the next run: ${budget}`,
      );
    }
    // A probe already read its page this run, and a page is read once a run.
    const ids = plan.ids.filter((id) => !probedPages.has(id));
    // A probe's page is due, like the pages the plan chose. The plan has counted it already if it
    // chose it too; one that the item budget left out of its choice is counted twice.
    summary.due = plan.due + probedPages.size - (plan.ids.length - ids.length);

    // Pages in a row by source that were blocked or that strained their host, and the pages each
    // paused source left unread. They stay due, so an ordinary run's next one reads them; under --all every
    // page was due, so none is promised to the next run, as the note below says. Both come from
    // steps' results, so a run that replays its steps pauses at the same page.
    const inARow = new Map<string, number>();
    const paused = new Map<string, number>();
    for (let start = 0; start < ids.length; start += ITEMS_PER_STEP) {
      const batch = await step.do(`items:${start}`, () =>
        ports.withDb((db) => itemsByIds(db, ids.slice(start, start + ITEMS_PER_STEP))),
      );
      for (const item of batch) {
        const left = paused.get(item.sourceId);
        if (left !== undefined) {
          paused.set(item.sourceId, left + 1);
          continue;
        }
        const refreshed = await refreshItem(context, item, summary, step, ports);
        heard(item.sourceId, refreshed.site);
        // The pages read: a planned page that's no longer live when its batch loads isn't one, and
        // neither is one a paused source left unread.
        summary.items += 1;
        // A block counts only when the host answered it; a strain always does. A gate refusal sent
        // no request, and starts the count again, as any other answer does.
        const counts =
          (refreshed.outcome === 'blocked' && refreshed.hostAnswered) || refreshed.strained;
        const count = counts ? (inARow.get(item.sourceId) ?? 0) + 1 : 0;
        inARow.set(item.sourceId, count);
        if (count >= SOURCE_PAUSE_AFTER) paused.set(item.sourceId, 0);
        if (refreshed.waitsForBudget) budgetWaits += 1;
      }
    }
    summary.paused = Object.fromEntries(paused);
    for (const [sourceId, left] of paused) {
      if (left === 0) continue;
      // Under --all every live page was due, and the next ordinary run reads only the pages whose
      // freshness has run out, which may be none of these. So they aren't said to wait for it.
      const fate =
        params.all === true
          ? `${left === 1 ? 'page wasn’t' : 'pages weren’t'} read`
          : `${left === 1 ? 'page waits' : 'pages wait'} for the next run`;
      note(
        summary,
        `${sourceId}: paused after ${SOURCE_PAUSE_AFTER} pages in a row were blocked or strained; ${left} ${fate}`,
      );
    }
    if (budgetWaits > 0) {
      const { llmTokensPerRun } = context.definition.budget;
      note(
        summary,
        `${budgetWaits} ${budgetWaits === 1 ? 'page waits' : 'pages wait'} for the next run: this run’s LLM budget of ${llmTokensPerRun.toLocaleString('en-US')} tokens is spent`,
      );
    }

    // The run's verdict for each source, counted across runs (ADR 0006). A refused source whose
    // probe didn't get through counts no blocked run: what its probe met is kept as the probe's.
    // Counting a blocked source also takes back this run's blocks on its pages, which would count
    // toward refusing them (ADR 0005), and a refused page leaves resolution and the snapshot. So
    // this step comes before them.
    const verdicts: Record<string, SourceVerdict> = {};
    const probes: Record<string, SourceProbe> = {};
    for (const source of context.definition.sources) {
      const probe = probed.get(source.id);
      if (probed.has(source.id) && probe !== 'through') {
        verdicts[source.id] = 'untouched';
        probes[source.id] = probe === 'refused' ? 'blocked' : 'no answer';
      } else {
        verdicts[source.id] = sourceVerdict(answers.get(source.id) ?? []);
      }
    }
    const counted = await step.do('sources', () =>
      ports.withDb((db) =>
        recordSourceRuns(db, { datasetId, at: context.startedAt, verdicts, probes }),
      ),
    );
    const probedOutcomes = [...probed.keys()].map((id) => ({
      id,
      outcome: probes[id] ?? ('through' as const),
    }));
    if (counted.blocked.length + counted.refused.length + probedOutcomes.length > 0) {
      summary.sources = {
        blocked: counted.blocked,
        refused: counted.refused,
        probed: probedOutcomes,
      };
    }
    for (const id of counted.refused) {
      note(
        summary,
        `${id}: refused after ${REFUSE_AFTER_RUNS} blocked runs in a row; later runs only probe it, until a probe gets through or it’s revived`,
      );
    }
    for (const { id, outcome } of probedOutcomes) {
      note(
        summary,
        outcome === 'through'
          ? `${id}: its probe got through, so it’s live again`
          : `${id}: still refused; its probe ${outcome === 'blocked' ? 'was blocked' : 'got no answer'}`,
      );
    }

    // Resolution, then the match questions it raised, then resolution again with their verdicts.
    // The counts stay exact. Only the notes, one for each page left unresolved and each claim in
    // conflict, are held to what a step's result may carry.
    const first = await step.do('resolve', () => resolveStep(context, ports));
    let resolved = first;
    // A resolution kept by an earlier version has no questions: its pages wait for the next run.
    const questions = first.questions ?? [];
    for (const question of questions) {
      const matched = await step.do(`match:${question.itemId}:${question.entityId}`, () =>
        matchItem(context, question, budgetLeft(context, summary), ports),
      );
      const counts = decisionsOf(summary, 'match');
      counts[matched.outcome] += 1;
      counts.inputTokens += matched.usage.inputTokens;
      counts.outputTokens += matched.usage.outputTokens;
      if (matched.note !== null) note(summary, matched.note);
    }
    if (questions.length > 0) {
      const again = await step.do('resolve:matched', () => resolveStep(context, ports));
      resolved = {
        ...again,
        created: first.created + again.created,
        linked: first.linked + again.linked,
      };
    }
    summary.entities = {
      created: resolved.created,
      linked: resolved.linked,
      conflicts: resolved.conflicts,
      unresolved: resolved.unresolved,
      waiting: resolved.waiting,
    };
    for (const text of resolved.notes) note(summary, text);

    summary.snapshot = await step.do('snapshot', () => publish(context, ports));
    await step.do('finish', () =>
      ports.withDb((db) => finishRun(db, runId, { status: 'complete', summary })),
    );
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await step.do('fail', () =>
      ports.withDb((db) => finishRun(db, runId, { status: 'failed', error: storable(message) })),
    );
    throw error;
  }
}

function emptySummary(): RunSummary {
  return {
    items: 0,
    live: 0,
    due: 0,
    discovery: {
      sources: 0,
      sitemaps: 0,
      listed: 0,
      added: 0,
      revived: 0,
      missing: 0,
      gone: 0,
      incomplete: [],
    },
    fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
    statements: { ...NO_CHANGE },
    llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
    entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0, waiting: 0 },
    snapshot: { published: false, reason: 'the run didn’t reach publishing', excluded: [] },
    notes: [],
  };
}

function note(summary: RunSummary, text: string) {
  if (summary.notes.length < MAX_NOTES) summary.notes.push(storable(text));
}

/** Fetches one page; reads it when it changed or its statements came from older code; classifies it. */
async function refreshItem(
  context: Context,
  item: ItemRef,
  summary: RunSummary,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<{
  outcome: Outcome;
  hostAnswered: boolean;
  strained: boolean;
  site: SiteAnswer | null;
  waitsForBudget: boolean;
}> {
  const fetched = await fetchWithWaits(context, item, step, ports);
  summary.fetches[fetched.outcome] += 1;
  summary.statements.reseen += fetched.reseen;
  if (fetched.note !== null) note(summary, fetched.note);
  // What the fetch step's result says of the host, which a run that replays its steps reads again.
  const host = {
    outcome: fetched.outcome,
    hostAnswered: fetched.hostAnswered,
    strained: fetched.strained === true,
    site: fetched.site ?? null,
  };
  if (!fetched.extract) return { ...host, waitsForBudget: false };
  const extracted = await step.do(`extract:${item.id}`, () =>
    extractItem(context, item, fetched, budgetLeft(context, summary), ports),
  );
  summary.statements.added += extracted.statements.added;
  summary.statements.reseen += extracted.statements.reseen;
  summary.statements.withdrawn += extracted.statements.withdrawn;
  summary.llm[extracted.llm] += 1;
  summary.llm.inputTokens += extracted.usage.inputTokens;
  summary.llm.outputTokens += extracted.usage.outputTokens;
  for (const text of extracted.notes) note(summary, text);
  let waitsForBudget = extracted.waitsForBudget;
  if (extracted.read && classifyTarget(context.definition, item) !== null) {
    // A page whose LLM step failed or waited for the budget is read again next run, whatever
    // classifying it comes to.
    const complete = extracted.llm !== 'failed' && !extracted.waitsForBudget;
    const classified = await step.do(`classify:${item.id}`, () =>
      classifyItem(context, item, fetched, budgetLeft(context, summary), ports, complete),
    );
    const counts = decisionsOf(summary, 'classify');
    counts[classified.outcome] += 1;
    counts.inputTokens += classified.usage.inputTokens;
    counts.outputTokens += classified.usage.outputTokens;
    if (classified.irrelevant) summary.irrelevant = (summary.irrelevant ?? 0) + 1;
    if (classified.note !== null) note(summary, classified.note);
    waitsForBudget ||= classified.outcome === 'skipped';
  }
  return { ...host, waitsForBudget };
}

/**
 * At most MAX_NOTES notes, then one line saying how many more there were. Workflows keep each
 * step's result as JSON and cap its size, so a step can't return a note for every one of a page's
 * hundred thousand bad values. Only the notes that are kept are built.
 */
function capped<T>(
  items: T[],
  render: (item: T) => string,
  more: (count: number) => string,
): string[] {
  const notes = items.slice(0, MAX_NOTES).map(render);
  if (items.length > MAX_NOTES) notes.push(more(items.length - MAX_NOTES));
  return notes;
}

/**
 * Joins pages to entities, and returns the match questions to ask, with notes held to what a step
 * carries. A pair that was escalated when no decider could be asked is a question again once one
 * can, which takes a decider and a dataset that allows it. A site's own refusal is for the
 * question's step to find.
 */
async function resolveStep(context: Context, ports: RefreshPorts) {
  const resolved = await ports.withDb((db) =>
    resolveEntities(db, {
      datasetId: context.datasetId,
      definition: context.definition,
      maxQuestions: MAX_MATCH_QUESTIONS,
      deciderCanAnswer:
        ports.decider !== null && context.definition.policy.purposes.includes('ai-input'),
    }),
  );
  return {
    ...resolved,
    notes: capped(
      resolved.notes,
      (text) => text,
      (count) => `${count} more notes about entities`,
    ),
  };
}

/**
 * Fetches a page, sleeping between steps whenever its host asks for a longer wait. An attempt that
 * was put off at a redirect's later hop picks up there, from what the step before it returned, so
 * a run that replays its steps asks for the same hops.
 */
async function fetchWithWaits(
  context: Context,
  item: ItemRef,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<Fetched> {
  let resume: Resume | undefined;
  for (let attempt = 0; ; attempt += 1) {
    const from = resume;
    const result = await step.do(`fetch:${item.id}:${attempt}`, () =>
      fetchItem(context, item, attempt, ports, from),
    );
    if (result.kind === 'done') return result.fetched;
    // A result kept by an earlier version has none, and starts again from the page's own address.
    resume = result.resume;
    await step.sleep(`wait:${item.id}:${attempt}`, result.retryAfterMs);
  }
}

/** What a fetch came to, before it's logged. */
interface Attempt {
  outcome: Outcome;
  policy: 'allowed' | 'denied';
  policyReason: string | null;
  httpStatus: number | null;
  finalUrl: string;
  bytes: number | null;
  error: string | null;
  page?: { contentHash: string; etag: string | null; lastModified: string | null };
}

async function fetchItem(
  context: Context,
  item: ItemRef,
  attempt: number,
  ports: RefreshPorts,
  resume: Resume | undefined,
): Promise<
  { kind: 'later'; retryAfterMs: number; resume: Resume } | { kind: 'done'; fetched: Fetched }
> {
  const startedAt = ports.now();
  const requested = await request(context, item, attempt >= MAX_WAITS, ports, resume);
  if (requested.kind === 'later') return requested;
  const { attempt: answer, signals, noAnswer, site } = requested;

  // The same run, page, and attempt make the same ID, so a step that runs again logs one fetch.
  const fetchId = await stableId('fe', context.runId, item.id, attempt);
  // A page whose statements came from older code isn't current. Neither is one the LLM read
  // while its site now says ai-input=no: it's extracted once more, and the LLM step withdraws
  // what the LLM said and clears its hash, so the page is current again next time. The same goes
  // for a page whose category the decider gave, though the LLM read nothing else of it: its
  // classify step finds the answer can't stand, and withdraws it. That statement is looked up only
  // for such a page, so a run costs nothing more otherwise.
  const noAiInput = signals['ai-input'] === 'no';
  let current =
    item.extractedWith === extractionTag(context.revision) &&
    !(noAiInput && item.extractInputHash !== null);
  if (current && noAiInput && answer.outcome === 'unchanged') {
    current = !(await decidedByLlm(context, item, ports));
  }
  const extract = answer.outcome === 'changed' || (answer.outcome === 'unchanged' && !current);
  const reseen = await ports.withDb(async (db) => {
    const logged: FetchInput = {
      id: fetchId,
      runId: context.runId,
      itemId: item.id,
      url: item.locator,
      method: 'http',
      signals,
      startedAt,
      durationMs: ports.now().getTime() - startedAt.getTime(),
      ...answer,
      // The page now stored isn't the one the item's statements came from, and it hasn't been
      // read yet. Until the extract step has, the item must not look current: if the run ended
      // before then, the next fetch of the same bytes would be "unchanged" and "current", and would
      // re-see the old statements as fresh. The mark goes in with the fetch, in one transaction.
      ...(answer.outcome === 'changed'
        ? { extractedWith: retryTag(context.revision), llm: 'skipped: not read yet' }
        : {}),
    };
    await recordFetch(db, logged);
    // An unchanged page whose statements are current says what it said before.
    return answer.outcome === 'unchanged' && current
      ? reseeStatements(db, { itemId: item.id, fetchId, seenAt: ports.now() })
      : 0;
  });
  const settled = answer.outcome === 'changed' || answer.outcome === 'unchanged';
  const why = answer.error ?? answer.policyReason;
  return {
    kind: 'done',
    fetched: {
      fetchId,
      outcome: answer.outcome,
      hostAnswered: answer.httpStatus !== null,
      strained: noAnswer || strains(answer.httpStatus),
      site,
      finalUrl: answer.finalUrl,
      signals,
      contentHash: answer.page?.contentHash ?? item.contentHash,
      extract,
      reseen,
      note: settled
        ? null
        : storable(`${item.locator}: ${answer.outcome}${why === null ? '' : ` (${why})`}`),
    },
  };
}

/**
 * Whether an answer's status strains its host, as the gate backs off on: a 429 or a 5xx. The gate
 * backs off on blocks too, which the run counts as blocks.
 */
function strains(status: number | null): boolean {
  return status !== null && (status === 429 || status >= 500);
}

/**
 * Asks for a page through its host's gate, and says what came of it, and whether no answer came to
 * a request the gate let go.
 */
async function request(
  context: Context,
  item: ItemRef,
  giveUp: boolean,
  ports: RefreshPorts,
  resume: Resume | undefined,
): Promise<
  | { kind: 'later'; retryAfterMs: number; resume: Resume }
  | {
      kind: 'answered';
      attempt: Attempt;
      signals: ContentSignals;
      noAnswer: boolean;
      site: SiteAnswer | null;
    }
> {
  // Definitions keep a page as written and only validate it. From here on, every hop and the
  // fetch log's final address use its href, as the redirects already do.
  const answer = await requestThroughGate(ports, new URL(item.locator).href, {
    minIntervalMs: intervalFor(context, item.sourceId),
    giveUp,
    headers: validators(item),
    resume,
  });
  if (answer.kind === 'later') return answer;
  const site = siteAnswerOf(answer);
  const answered = (attempt: Omit<Attempt, 'policy' | 'policyReason'> & Partial<Attempt>) => {
    const whole = { policy: 'allowed' as const, policyReason: null, ...attempt };
    return {
      kind: 'answered' as const,
      signals: answer.signals,
      noAnswer: answer.kind === 'failed' && answer.noAnswer,
      site,
      // A reason or an error can quote the site, such as the Location of a redirect that isn't an
      // address or of a robots.txt's redirect. Both are stored as text, and Postgres refuses U+0000.
      attempt: {
        ...whole,
        policyReason: whole.policyReason === null ? null : storable(whole.policyReason),
        error: whole.error === null ? null : storable(whole.error),
      },
    };
  };
  if (answer.kind === 'denied') {
    return answered({
      outcome: answer.outcome,
      policy: 'denied',
      policyReason: answer.reason,
      httpStatus: null,
      finalUrl: answer.url,
      bytes: null,
      error: null,
    });
  }
  if (answer.kind === 'failed') {
    return answered({
      outcome: 'failed',
      httpStatus: answer.httpStatus,
      finalUrl: answer.url,
      bytes: null,
      error: answer.error,
    });
  }
  if (answer.status < 400 && redirectedAway(context.definition, item, answer.url)) {
    // Gone, as a 404 is: two in a row make the page gone (ADR 0005).
    return answered({
      outcome: 'gone',
      httpStatus: answer.status,
      finalUrl: answer.url,
      bytes: null,
      error: `redirected away, to ${answer.url}`,
    });
  }
  const classified = classifyResponse(answer);
  if (classified.kind === 'final') {
    if (classified.outcome === 'unchanged' && item.contentHash === null) {
      return answered({
        outcome: 'failed',
        httpStatus: answer.status,
        finalUrl: answer.url,
        bytes: null,
        error: 'the site said the page is unchanged, but no copy of it is stored',
      });
    }
    return answered({
      outcome: classified.outcome,
      httpStatus: answer.status,
      finalUrl: answer.url,
      bytes: null,
      error: classified.error,
    });
  }
  const contentHash = await sha256Hex(answer.body);
  if (contentHash !== item.contentHash) {
    await ports.blobs.put(pageKey(contentHash), answer.body, 'text/html; charset=utf-8');
  }
  return answered({
    outcome: contentHash === item.contentHash ? 'unchanged' : 'changed',
    httpStatus: answer.status,
    finalUrl: answer.url,
    bytes: answer.body.byteLength,
    error: null,
    page: {
      contentHash,
      etag: answer.headers.etag ?? null,
      lastModified: answer.headers['last-modified'] ?? null,
    },
  });
}

/**
 * Whether a sitemap source's page was redirected away from itself (ADR 0005): to an address whose
 * path the source's patterns wouldn't list, that doesn't keep the page's name, which is the last
 * segment of its path. A discontinued product's page often redirects to a collection or the home
 * page, which are other pages. A store sends a region to a path of its own, as /products/c1 to
 * /en-gb/products/c1, which no pattern lists but which is the same page, so it is followed. The
 * host is left out, since a store that sends a region to another host keeps its paths. A pages
 * source lists its pages by hand, so its redirects are followed.
 */
function redirectedAway(definition: Definition, item: ItemRef, finalUrl: string): boolean {
  const source = definition.sources.find((one) => one.id === item.sourceId);
  const from = new URL(item.locator);
  if (source?.kind !== 'sitemap' || finalUrl === from.href) return false;
  const to = new URL(finalUrl);
  const path = to.pathname + to.search;
  const listed =
    source.include.some((pattern) => pathPatternMatches(pattern, path)) &&
    !source.exclude.some((pattern) => pathPatternMatches(pattern, path));
  return !listed && lastSegment(to.pathname) !== lastSegment(from.pathname);
}

/**
 * A path's last segment that isn't empty, so a trailing slash doesn't matter, with its percent
 * escapes in uppercase, however they were written. The root has none (''), so a redirect to it
 * leaves every page that has one.
 */
function lastSegment(pathname: string): string {
  const last = pathname.split('/').findLast((segment) => segment !== '') ?? '';
  return last.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

/** Conditional request headers, sent only when a copy of the page is stored to fall back on. */
function validators(item: ItemRef): Record<string, string> {
  if (item.contentHash === null) return {};
  return {
    ...(item.etag === null ? {} : { 'if-none-match': item.etag }),
    ...(item.lastModified === null ? {} : { 'if-modified-since': item.lastModified }),
  };
}

/**
 * A page that wasn't read costs only itself. Nothing is written but the retry mark, and its
 * statements stay as they were. A changed page already carries the fetch step's mark, and that is
 * what has the next run read its stored copy again. This mark matters for a page that was current
 * and is read again because its site now says ai-input=no: without it, the page would look
 * current again once the site changed its mind, and its statements, which this read never
 * confirmed, would be re-seen as fresh.
 */
async function unread(
  context: Context,
  item: ItemRef,
  fetched: Fetched,
  why: string,
  ports: RefreshPorts,
): Promise<Extracted> {
  await ports.withDb((db) =>
    recordExtraction(db, {
      itemId: item.id,
      fetchId: fetched.fetchId,
      extractedWith: retryTag(context.revision),
      llm: 'skipped: the page wasn’t read',
      usage: NO_USAGE,
    }),
  );
  return {
    statements: NO_CHANGE,
    llm: 'skipped',
    usage: NO_USAGE,
    // The reason can quote an exception's message, and this note is part of the step's result.
    notes: [storable(`${item.locator}: ${why}`)],
    read: false,
    waitsForBudget: false,
  };
}

/** Extracts a page from its stored copy, then asks the LLM for what's still missing. */
async function extractItem(
  context: Context,
  item: ItemRef,
  fetched: Fetched,
  tokensLeft: number,
  ports: RefreshPorts,
): Promise<Extracted> {
  const { definition, revision, datasetId } = context;
  const source = definition.sources.find((candidate) => candidate.id === item.sourceId);
  const recordType = definition.recordTypes[item.recordType];
  if (source === undefined || recordType === undefined) {
    throw new Error(`${item.locator} has no source or record type in revision ${revision}`);
  }
  const body =
    fetched.contentHash === null ? null : await ports.blobs.get(pageKey(fetched.contentHash));
  if (body === null) throw new Error(`The stored copy of ${item.locator} is missing`);

  const pack = recordType.pack === undefined ? null : (ports.packs[recordType.pack] ?? null);
  let page: Page;
  let extraction: PageExtraction;
  try {
    page = parsePage(new TextDecoder().decode(body), fetched.finalUrl);
    extraction = extractFromPage({ page, source, recordType, pack });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unread(context, item, fetched, `the page couldn’t be read: ${message}`, ports);
  }
  if (extraction.statements.length > MAX_PAGE_STATEMENTS) {
    return unread(
      context,
      item,
      fetched,
      `the page says more than ${MAX_PAGE_STATEMENTS.toLocaleString('en-US')} things, so it wasn’t read`,
      ports,
    );
  }
  const seenAt = ports.now();
  const decided = cascadeField(source, recordType);
  // The cascade owns the decided field, so the page and the LLM speak for every other field, and
  // neither gives or withdraws a decided answer.
  const own = speaksFor(recordType, decided?.[0] ?? null);
  const pageCounts = await ports.withDb((db) =>
    writeStatements(db, {
      datasetId,
      itemId: item.id,
      fetchId: fetched.fetchId,
      seenAt,
      methods: PAGE_METHODS,
      statements:
        decided === null
          ? extraction.statements
          : extraction.statements.filter((statement) => statement.property !== decided[0]),
      ...own,
    }),
  );
  const llm = await askLlm(
    context,
    item,
    fetched,
    page,
    recordType,
    own,
    extraction.missing,
    seenAt,
    tokensLeft,
    ports,
  );
  await ports.withDb((db) =>
    recordExtraction(db, {
      itemId: item.id,
      fetchId: fetched.fetchId,
      // A failed LLM step leaves the page not current, so the next run reads the stored copy and
      // asks again, even after a 304 or an unchanged hash. So does an LLM step that waited for the
      // run's budget. A page whose category the cascade decides isn't current until its classify
      // step has finished, and that step marks it.
      extractedWith:
        llm.outcome === 'failed' || llm.waitsForBudget === true || decided !== null
          ? retryTag(revision)
          : extractionTag(revision),
      extractInputHash: llm.inputHash,
      // The detail can quote an LLM error's message, and a NUL in it would fail this write after
      // the LLM has been paid for.
      llm: storable(llm.detail),
      usage: llm.usage,
    }),
  );
  const notes = capped(
    extraction.rejected,
    (rejected) =>
      `${item.locator}: ${rejected.property} from ${rejected.path} is ${rejected.reason}`,
    (count) => `${item.locator}: ${count} more values were rejected`,
  );
  if (llm.note !== null) notes.push(llm.note);
  return {
    statements: {
      added: pageCounts.added + llm.counts.added,
      reseen: pageCounts.reseen + llm.counts.reseen,
      withdrawn: pageCounts.withdrawn + llm.counts.withdrawn,
    },
    llm: llm.outcome,
    usage: llm.usage,
    notes,
    read: true,
    waitsForBudget: llm.waitsForBudget === true,
  };
}

/**
 * The properties a write by the page's extraction or by the LLM speaks for: every field but the
 * one the cascade decides. With no decided field none is named, so the write speaks for every
 * property, as it did before there was a cascade.
 */
function speaksFor(recordType: RecordType, decided: string | null): { properties?: string[] } {
  return decided === null
    ? {}
    : { properties: Object.keys(recordType.fields).filter((name) => name !== decided) };
}

interface LlmStep {
  outcome: Extracted['llm'];
  /** What the fetch log says the LLM step did. */
  detail: string;
  usage: LlmUsage;
  counts: StatementCounts;
  /** The new question's hash; null clears the stored one; undefined keeps it. */
  inputHash: string | null | undefined;
  note: string | null;
  /** Whether the LLM wasn't asked because the run's budget was spent. */
  waitsForBudget?: boolean;
}

async function askLlm(
  context: Context,
  item: ItemRef,
  fetched: Fetched,
  page: Page,
  recordType: RecordType,
  own: { properties?: string[] },
  missing: string[],
  seenAt: Date,
  tokensLeft: number,
  ports: RefreshPorts,
): Promise<LlmStep> {
  const skipped = (why: string, more: Partial<LlmStep> = {}): LlmStep => ({
    outcome: 'skipped',
    detail: `skipped: ${why}`,
    usage: NO_USAGE,
    counts: NO_CHANGE,
    inputHash: undefined,
    note: null,
    ...more,
  });
  // The LLM speaks for every field but the cascade's, so what it said of a field it no longer
  // fills is withdrawn with the rest, and the cascade's answer is left alone.
  const write = {
    datasetId: context.datasetId,
    itemId: item.id,
    fetchId: fetched.fetchId,
    seenAt,
    methods: ['llm'] as const,
    ...own,
  };

  const fields = llmFields(recordType, missing);
  if (fields.length === 0) return skipped('nothing is left for it to fill');
  const refusal = !context.definition.policy.purposes.includes('ai-input')
    ? 'the dataset doesn’t declare ai-input'
    : fetched.signals['ai-input'] === 'no'
      ? 'the site says ai-input=no'
      : null;
  if (refusal !== null) {
    // Reading a page with the LLM needs both the dataset's purpose and the site's consent, so
    // anything the LLM read from it before is withdrawn too.
    const counts = await ports.withDb((db) => writeStatements(db, { ...write, statements: [] }));
    return skipped(refusal, { counts, inputHash: null });
  }
  const llm = ports.llm;
  if (llm === null) return skipped('no LLM is configured');

  const inputHash = await llmInputHash({ model: llm.model, text: page.text, fields });
  if (inputHash === item.extractInputHash) {
    // The same text, fields, and model would get the same answer, so its statements are re-seen.
    // The cascade's answer isn't among them: nothing has confirmed it until its own step has.
    const reseen = await ports.withDb((db) =>
      reseeStatements(db, {
        itemId: item.id,
        fetchId: fetched.fetchId,
        seenAt,
        methods: ['llm'],
        ...own,
      }),
    );
    return {
      outcome: 'reused',
      detail: 'reused: the text and the fields are unchanged',
      usage: NO_USAGE,
      counts: { ...NO_CHANGE, reseen },
      inputHash,
      note: null,
    };
  }
  // A reused answer costs nothing; a new one waits for the next run's budget.
  if (tokensLeft <= 0) return skipped('the run’s LLM budget is spent', { waitsForBudget: true });

  // The question names the page that was listed, which the dataset's owner chose. After a
  // redirect the final address is the site's text, and it would sit outside the wrapper around
  // untrusted content.
  const question = buildLlmRequest({ url: new URL(item.locator).href, text: page.text, fields });
  let answer: { output: Record<string, unknown> | null; usage: LlmUsage };
  try {
    answer = await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...skipped(''),
      outcome: 'failed',
      detail: `failed: ${message}`,
      note: storable(`${item.locator}: the LLM call failed: ${message}`),
    };
  }
  if (answer.output === null) {
    return {
      ...skipped(''),
      outcome: 'failed',
      detail: 'failed: the answer didn’t fit the schema',
      usage: answer.usage,
      note: `${item.locator}: the LLM’s answer didn’t fit the schema`,
    };
  }
  const accepted = acceptLlmOutput({ output: answer.output, text: page.text, fields });
  const counts = await ports.withDb((db) =>
    writeStatements(db, { ...write, statements: accepted.statements }),
  );
  const dropped = accepted.rejected.length;
  return {
    outcome: 'ran',
    detail: `ran: kept ${accepted.statements.length}, dropped ${dropped}`,
    usage: answer.usage,
    counts,
    inputHash,
    note: dropped === 0 ? null : `${item.locator}: dropped ${dropped} of the LLM’s values`,
  };
}
