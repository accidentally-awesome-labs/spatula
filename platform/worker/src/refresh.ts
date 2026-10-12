import {
  acceptLlmOutput,
  buildLlmRequest,
  buildRecords,
  EXTRACTION_VERSION,
  extractFromPage,
  LLM_MAX_TOKENS,
  llmFields,
  llmInputHash,
  newId,
  PAGE_METHODS,
  parsePage,
  pathPatternMatches,
  sha256Hex,
  snapshotSchema,
  stableId,
  stableStringify,
  type ContentSignals,
  type Definition,
  type EntityStatements,
  type GateDecision,
  type LlmPort,
  type LlmUsage,
  type Outcome,
  type PackRegistry,
  type Page,
  type PageExtraction,
  type PublishResult,
  type RecordType,
  type RunSummary,
  type Snapshot,
  type SnapshotRecord,
  type StatementView,
} from '@spatula/core';
import {
  commitSnapshot,
  currentStatements,
  dueItems,
  finishRun,
  getDataset,
  itemsByIds,
  latestSnapshot,
  recordExtraction,
  recordFetch,
  reseeStatements,
  resolveEntities,
  startRun,
  writeStatements,
  type Executor,
  type FetchInput,
  type ItemRef,
  type StatementCounts,
} from '@spatula/store';
import { discoverSource } from './discovery';
import { MAX_WAITS, requestThroughGate } from './requests';
import { storable } from './text';

/*
 * One refresh of one dataset. A sitemap source's sitemaps are read first (discovery.ts), which
 * lists its pages. Each page is fetched in its own step, through the gate, and only a
 * page that changed (or whose statements came from older code) is extracted, in a step of its
 * own, from the copy kept under its hash. A failed or blocked fetch changes no values. The LLM is
 * asked only for fields nothing else filled, only where the dataset and the site allow AI input,
 * and only when its question changed. Then entities are resolved, and a snapshot is published if
 * the records changed. Nothing here imports Cloudflare: the Workflow passes real ports, and the
 * tests pass fakes.
 */

/** The Workflow's steps, as the pipeline uses them. Step results are kept as JSON. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

/** Whether a request to a URL may go now, and what came of it. */
export interface GatePort {
  reserve(
    url: string,
    request: { minIntervalMs: number; maxWaitMs: number },
  ): Promise<GateDecision>;
  record(url: string, response: { status: number; retryAfter: string | null }): Promise<void>;
}

export type HttpResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      truncated: boolean;
    }
  | { ok: false; error: string };

/**
 * One GET, never following redirects. Header names are lowercase; the body is read only for a 2xx,
 * up to `maxBytes` (5 MB unless the caller says otherwise).
 */
export interface HttpPort {
  get(
    url: string,
    headers: Record<string, string>,
    options?: { maxBytes?: number; accept?: string },
  ): Promise<HttpResult>;
}

export interface BlobPort {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface RefreshPorts {
  withDb<T>(fn: (db: Executor) => Promise<T>): Promise<T>;
  gate: GatePort;
  http: HttpPort;
  blobs: BlobPort;
  llm: LlmPort | null;
  packs: PackRegistry;
  now(): Date;
  /** A wait inside a step, never longer than MAX_INLINE_WAIT_MS. */
  wait(ms: number): Promise<void>;
}

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

const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };
const NO_CHANGE: StatementCounts = { added: 0, reseen: 0, withdrawn: 0 };

export class DatasetMissingError extends Error {
  constructor(datasetId: string) {
    super(`Dataset ${datasetId} doesn’t exist`);
    this.name = 'DatasetMissingError';
  }
}

/** Where a page's HTML is kept: under its SHA-256, so an unchanged page is stored once. */
export const pageKey = (contentHash: string) => `pages/${contentHash}`;
export const snapshotKey = (datasetId: string, snapshotId: string) =>
  `datasets/${datasetId}/snapshots/${snapshotId}.json`;
/** Which definition revision and extraction code a page's statements came from. */
export const extractionTag = (revision: number) => `r${revision}.v${EXTRACTION_VERSION}`;
/** What a page is marked with when it has to be read again though nothing about it changed. */
const retryTag = (revision: number) => `${extractionTag(revision)}.retry`;

/**
 * What a snapshot's records say, without when each value was last seen. A run that only sees
 * the same values again publishes nothing; consumers already have them.
 */
export async function recordsDigest(records: SnapshotRecord[]): Promise<string> {
  return sha256Hex(
    stableStringify(
      records.map((record) => ({
        canonicalId: record.canonicalId,
        fields: record.fields,
        provenance: Object.fromEntries(
          Object.entries(record.provenance).map(([name, { sourceUrl, method, confidence }]) => [
            name,
            { sourceUrl, method, confidence },
          ]),
        ),
      })),
    ),
  );
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
  if (headers['cf-mitigated'] === 'challenge')
    return final('blocked', 'the site answered with a challenge');
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

interface Context {
  runId: string;
  datasetId: string;
  revision: number;
  definition: Definition;
  startedAt: Date;
}

/** A fetch's result, as its step returns it. */
interface Fetched {
  fetchId: string;
  outcome: Outcome;
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
}

export async function runRefresh(
  params: RefreshParams,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<RunSummary> {
  const { runId, datasetId } = params;
  try {
    const loaded = await step.do('load', () =>
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
        };
      }),
    );
    const context: Context = {
      runId,
      datasetId,
      revision: loaded.revision,
      definition: loaded.definition,
      startedAt: new Date(loaded.startedAt),
    };
    const summary = emptySummary();

    for (const source of context.definition.sources) {
      if (source.kind !== 'sitemap') continue;
      const found = await discoverSource(context, source, step, ports);
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
    summary.due = plan.due;
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

    for (let start = 0; start < plan.ids.length; start += ITEMS_PER_STEP) {
      const batch = await step.do(`items:${start}`, () =>
        ports.withDb((db) => itemsByIds(db, plan.ids.slice(start, start + ITEMS_PER_STEP))),
      );
      for (const item of batch) {
        await refreshItem(context, item, summary, step, ports);
        // The pages read: a planned page that's no longer live when its batch loads isn't one.
        summary.items += 1;
      }
    }

    // The counts stay exact. Only the notes, one for each page left unresolved and each claim in
    // conflict, are held to what a step's result may carry.
    const { notes, ...entities } = await step.do('resolve', async () => {
      const resolved = await ports.withDb((db) =>
        resolveEntities(db, { datasetId, definition: context.definition }),
      );
      return {
        ...resolved,
        notes: capped(
          resolved.notes,
          (text) => text,
          (count) => `${count} more notes about entities`,
        ),
      };
    });
    summary.entities = entities;
    for (const text of notes) note(summary, text);

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
    entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
    snapshot: { published: false, reason: 'the run didn’t reach publishing', excluded: [] },
    notes: [],
  };
}

function note(summary: RunSummary, text: string) {
  if (summary.notes.length < MAX_NOTES) summary.notes.push(storable(text));
}

/** Fetches one page, and reads it when it changed or its statements came from older code. */
async function refreshItem(
  context: Context,
  item: ItemRef,
  summary: RunSummary,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<Fetched> {
  const fetched = await fetchWithWaits(context, item, step, ports);
  summary.fetches[fetched.outcome] += 1;
  summary.statements.reseen += fetched.reseen;
  if (fetched.note !== null) note(summary, fetched.note);
  if (!fetched.extract) return fetched;
  const extracted = await step.do(`extract:${item.id}`, () =>
    extractItem(context, item, fetched, ports),
  );
  summary.statements.added += extracted.statements.added;
  summary.statements.reseen += extracted.statements.reseen;
  summary.statements.withdrawn += extracted.statements.withdrawn;
  summary.llm[extracted.llm] += 1;
  summary.llm.inputTokens += extracted.usage.inputTokens;
  summary.llm.outputTokens += extracted.usage.outputTokens;
  for (const text of extracted.notes) note(summary, text);
  return fetched;
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

/** Fetches a page, sleeping between steps whenever its host asks for a longer wait. */
async function fetchWithWaits(
  context: Context,
  item: ItemRef,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<Fetched> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await step.do(`fetch:${item.id}:${attempt}`, () =>
      fetchItem(context, item, attempt, ports),
    );
    if (result.kind === 'done') return result.fetched;
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
): Promise<{ kind: 'later'; retryAfterMs: number } | { kind: 'done'; fetched: Fetched }> {
  const startedAt = ports.now();
  const requested = await request(context, item, attempt >= MAX_WAITS, ports);
  if (requested.kind === 'later') return requested;
  const { attempt: answer, signals } = requested;

  // The same run, page, and attempt make the same ID, so a step that runs again logs one fetch.
  const fetchId = await stableId('fe', context.runId, item.id, attempt);
  // A page whose statements came from older code isn't current. Neither is one the LLM read
  // while its site now says ai-input=no: it's extracted once more, and the LLM step withdraws
  // what the LLM said and clears its hash, so the page is current again next time.
  const current =
    item.extractedWith === extractionTag(context.revision) &&
    !(signals['ai-input'] === 'no' && item.extractInputHash !== null);
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

/** Asks for a page through its host's gate, and says what came of it. */
async function request(
  context: Context,
  item: ItemRef,
  giveUp: boolean,
  ports: RefreshPorts,
): Promise<
  | { kind: 'later'; retryAfterMs: number }
  | { kind: 'answered'; attempt: Attempt; signals: ContentSignals }
> {
  // Definitions keep a page as written and only validate it. From here on, every hop and the
  // fetch log's final address use its href, as the redirects already do.
  const answer = await requestThroughGate(ports, new URL(item.locator).href, {
    minIntervalMs: context.definition.policy.perHostIntervalMs,
    giveUp,
    headers: validators(item),
  });
  if (answer.kind === 'later') return answer;
  const answered = (attempt: Omit<Attempt, 'policy' | 'policyReason'> & Partial<Attempt>) => {
    const whole = { policy: 'allowed' as const, policyReason: null, ...attempt };
    return {
      kind: 'answered' as const,
      signals: answer.signals,
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
  };
}

/** Extracts a page from its stored copy, then asks the LLM for what's still missing. */
async function extractItem(
  context: Context,
  item: ItemRef,
  fetched: Fetched,
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
  const pageCounts = await ports.withDb((db) =>
    writeStatements(db, {
      datasetId,
      itemId: item.id,
      fetchId: fetched.fetchId,
      seenAt,
      methods: PAGE_METHODS,
      statements: extraction.statements,
    }),
  );
  const llm = await askLlm(
    context,
    item,
    fetched,
    page,
    recordType,
    extraction.missing,
    seenAt,
    ports,
  );
  await ports.withDb((db) =>
    recordExtraction(db, {
      itemId: item.id,
      fetchId: fetched.fetchId,
      // A failed LLM step leaves the page not current, so the next run reads the stored copy and
      // asks again, even after a 304 or an unchanged hash.
      extractedWith: llm.outcome === 'failed' ? retryTag(revision) : extractionTag(revision),
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
  };
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
}

async function askLlm(
  context: Context,
  item: ItemRef,
  fetched: Fetched,
  page: Page,
  recordType: RecordType,
  missing: string[],
  seenAt: Date,
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
  const write = {
    datasetId: context.datasetId,
    itemId: item.id,
    fetchId: fetched.fetchId,
    seenAt,
    methods: ['llm'] as const,
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
    const reseen = await ports.withDb((db) =>
      reseeStatements(db, { itemId: item.id, fetchId: fetched.fetchId, seenAt, methods: ['llm'] }),
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

/**
 * Publishes the dataset's records, if they changed. The file goes to the blob store first; then
 * the head generation moves, compared and set. A step that runs again after publishing finds its
 * own snapshot and reports it.
 */
async function publish(context: Context, ports: RefreshPorts): Promise<PublishResult> {
  const { runId, datasetId, definition } = context;
  return ports.withDb(async (db) => {
    const latest = await latestSnapshot(db, datasetId);
    if (latest !== null && latest.runId === runId) {
      return {
        published: true,
        generation: latest.generation,
        snapshotId: latest.id,
        records: latest.recordCount,
        excluded: latest.report.excluded,
      };
    }
    const [recordType] = Object.values(definition.recordTypes);
    if (recordType === undefined) throw new Error(`Dataset ${datasetId} has no record type`);
    // Pushed in place: copying an entity's list for every statement would be quadratic.
    const said = new Map<string, StatementView[]>();
    for (const statement of await currentStatements(db, datasetId)) {
      const id = statement.entityId;
      if (id === null) continue;
      const list = said.get(id);
      if (list === undefined) said.set(id, [statement]);
      else list.push(statement);
    }
    const entities: EntityStatements[] = [...said].map(([canonicalId, statements]) => ({
      canonicalId,
      statements,
    }));
    const { records, excluded } = buildRecords(recordType, entities);
    if (records.length === 0)
      return { published: false, reason: 'no record is complete', excluded };
    const digest = await recordsDigest(records);
    if (latest !== null && latest.recordsSha256 === digest) {
      return {
        published: false,
        reason: `nothing changed since generation ${latest.generation}`,
        excluded,
      };
    }

    const dataset = await getDataset(db, datasetId);
    const generation = (dataset?.headGeneration ?? 0) + 1;
    const snapshot: Snapshot = {
      project: datasetId,
      snapshotId: newId('sn'),
      generation,
      publishedAt: ports.now().toISOString(),
      records,
    };
    const checked = snapshotSchema.safeParse(snapshot);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return {
        published: false,
        reason: `the snapshot breaks the published format at ${issue?.path.join('.')}: ${issue?.message}`,
        excluded,
      };
    }
    const body = JSON.stringify(snapshot);
    const key = snapshotKey(datasetId, snapshot.snapshotId);
    await ports.blobs.put(key, body, 'application/json');
    const committed = await commitSnapshot(db, {
      id: snapshot.snapshotId,
      datasetId,
      generation,
      runId,
      recordCount: records.length,
      recordsSha256: digest,
      key,
      sha256: await sha256Hex(body),
      bytes: new TextEncoder().encode(body).byteLength,
      publishedAt: snapshot.publishedAt,
      report: { excluded },
    });
    // Another run took this generation first. The step fails, and its retry starts from the new head.
    if (!committed.committed)
      throw new Error(`Generation ${committed.headGeneration} was published by another run`);
    return {
      published: true,
      generation,
      snapshotId: snapshot.snapshotId,
      records: records.length,
      excluded,
    };
  });
}
