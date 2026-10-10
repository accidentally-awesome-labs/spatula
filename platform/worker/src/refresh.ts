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
  sha256Hex,
  snapshotSchema,
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
  finishRun,
  getDataset,
  latestSnapshot,
  listLiveItems,
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

/*
 * One refresh of one dataset. Each page is fetched in its own step, through the gate, and only a
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

/** One GET, never following redirects. Header names are lowercase; the body is read only for a 2xx. */
export interface HttpPort {
  get(url: string, headers: Record<string, string>): Promise<HttpResult>;
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
}

/** Waits up to this long happen inside a fetch step; longer ones become Workflow sleeps. */
export const MAX_INLINE_WAIT_MS = 15_000;
/** How many times one page may be put off before the run records it as failed. */
export const MAX_WAITS = 5;
export const MAX_REDIRECTS = 5;
export const MAX_NOTES = 50;
/**
 * The most statements one page's extraction may yield. writeStatements inserts them in one
 * statement, 15 parameters to a row, and postgres.js refuses a statement with 65,534 parameters
 * or more. The cap also bounds the lists of IDs that writing re-sees and withdraws, and what
 * survivorship reads. An honest product page says a few dozen things.
 */
export const MAX_PAGE_STATEMENTS = 1_000;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
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
        return {
          revision: dataset.revision,
          definition: dataset.definition,
          items: await listLiveItems(db, datasetId),
        };
      }),
    );
    const context: Context = {
      runId,
      datasetId,
      revision: loaded.revision,
      definition: loaded.definition,
    };
    const summary = emptySummary(loaded.items.length);

    for (const item of loaded.items) {
      const fetched = await fetchWithWaits(context, item, step, ports);
      summary.fetches[fetched.outcome] += 1;
      summary.statements.reseen += fetched.reseen;
      if (fetched.note !== null) note(summary, fetched.note);
      if (!fetched.extract) continue;
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
    }

    // The counts stay exact. Only the notes, one for each page left unresolved and each claim in
    // conflict, are held to what a step's result may carry.
    const { notes, ...entities } = await step.do('resolve', async () => {
      const resolved = await ports.withDb((db) =>
        resolveEntities(db, { datasetId, definition: context.definition }),
      );
      return {
        ...resolved,
        notes: capped(resolved.notes, (count) => `${count} more notes about entities`),
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
      ports.withDb((db) => finishRun(db, runId, { status: 'failed', error: message })),
    );
    throw error;
  }
}

function emptySummary(items: number): RunSummary {
  return {
    items,
    fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
    statements: { ...NO_CHANGE },
    llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
    entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
    snapshot: { published: false, reason: 'the run didn’t reach publishing', excluded: [] },
    notes: [],
  };
}

function note(summary: RunSummary, text: string) {
  if (summary.notes.length < MAX_NOTES) summary.notes.push(text);
}

/**
 * At most MAX_NOTES notes, then one line saying how many more there were. Workflows keep each
 * step's result as JSON and cap its size, so a step can't return a note for every one of a page's
 * hundred thousand bad values.
 */
function capped(notes: string[], more: (count: number) => string): string[] {
  if (notes.length <= MAX_NOTES) return notes;
  return [...notes.slice(0, MAX_NOTES), more(notes.length - MAX_NOTES)];
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
      fetchItem(context, item, attempt >= MAX_WAITS, ports),
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
  giveUp: boolean,
  ports: RefreshPorts,
): Promise<{ kind: 'later'; retryAfterMs: number } | { kind: 'done'; fetched: Fetched }> {
  const startedAt = ports.now();
  const requested = await request(context, item, giveUp, ports);
  if (requested.kind === 'later') return requested;
  const { attempt, signals } = requested;

  const fetchId = newId('fe');
  // A page whose statements came from older code isn't current. Neither is one the LLM read
  // while its site now says ai-input=no: it's extracted once more, and the LLM step withdraws
  // what the LLM said and clears its hash, so the page is current again next time.
  const current =
    item.extractedWith === extractionTag(context.revision) &&
    !(signals['ai-input'] === 'no' && item.extractInputHash !== null);
  const extract = attempt.outcome === 'changed' || (attempt.outcome === 'unchanged' && !current);
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
      ...attempt,
    };
    await recordFetch(db, logged);
    // An unchanged page whose statements are current says what it said before.
    return attempt.outcome === 'unchanged' && current
      ? reseeStatements(db, { itemId: item.id, fetchId, seenAt: ports.now() })
      : 0;
  });
  const settled = attempt.outcome === 'changed' || attempt.outcome === 'unchanged';
  const why = attempt.error ?? attempt.policyReason;
  return {
    kind: 'done',
    fetched: {
      fetchId,
      outcome: attempt.outcome,
      finalUrl: attempt.finalUrl,
      signals,
      contentHash: attempt.page?.contentHash ?? item.contentHash,
      extract,
      reseen,
      note: settled
        ? null
        : `${item.locator}: ${attempt.outcome}${why === null ? '' : ` (${why})`}`,
    },
  };
}

/**
 * Asks for a page, following redirects. Every request, redirects included, goes through its
 * host's gate first, and its answer goes back to the gate. Only HTTPS addresses are followed.
 */
async function request(
  context: Context,
  item: ItemRef,
  giveUp: boolean,
  ports: RefreshPorts,
): Promise<
  | { kind: 'later'; retryAfterMs: number }
  | { kind: 'answered'; attempt: Attempt; signals: ContentSignals }
> {
  // Definitions keep a page as written and only validate it. From here on, every hop, the fetch
  // log's final address, and the LLM's question use its href, as the redirects already do.
  let url = new URL(item.locator).href;
  let signals: ContentSignals = {};
  const answered = (attempt: Omit<Attempt, 'policy' | 'policyReason'> & Partial<Attempt>) => ({
    kind: 'answered' as const,
    signals,
    attempt: { policy: 'allowed' as const, policyReason: null, ...attempt },
  });
  const failed = (error: string, httpStatus: number | null = null) =>
    answered({ outcome: 'failed', httpStatus, finalUrl: url, bytes: null, error });

  for (let hop = 0; ; hop += 1) {
    const decision = await ports.gate.reserve(url, {
      minIntervalMs: context.definition.policy.perHostIntervalMs,
      maxWaitMs: MAX_INLINE_WAIT_MS,
    });
    if (decision.kind === 'later') {
      if (!giveUp) return { kind: 'later', retryAfterMs: decision.retryAfterMs };
      return failed(`${decision.reason}, and the run stopped waiting after ${MAX_WAITS} tries`);
    }
    if (decision.kind === 'deny') {
      return answered({
        outcome: decision.outcome,
        policy: 'denied',
        policyReason: decision.reason,
        httpStatus: null,
        finalUrl: url,
        bytes: null,
        error: null,
      });
    }
    signals = decision.signals;
    if (decision.waitMs > 0) await ports.wait(decision.waitMs);

    const response = await ports.http.get(url, hop === 0 ? validators(item) : {});
    await ports.gate.record(
      url,
      response.ok
        ? { status: response.status, retryAfter: response.headers['retry-after'] ?? null }
        : { status: 0, retryAfter: null },
    );
    if (!response.ok) return failed(response.error);

    const location = response.headers.location;
    if (REDIRECTS.has(response.status) && location !== undefined) {
      const next = URL.canParse(location, url) ? new URL(location, url) : null;
      if (next === null)
        return failed(`redirected to ${location}, which isn’t an address`, response.status);
      if (next.protocol !== 'https:')
        return failed(`redirected to ${next.href}, which isn’t HTTPS`, response.status);
      if (hop === MAX_REDIRECTS)
        return failed(`redirected more than ${MAX_REDIRECTS} times`, response.status);
      url = next.href;
      continue;
    }

    const classified = classifyResponse(response);
    if (classified.kind === 'final') {
      if (classified.outcome === 'unchanged' && item.contentHash === null) {
        return failed(
          'the site said the page is unchanged, but no copy of it is stored',
          response.status,
        );
      }
      return answered({
        outcome: classified.outcome,
        httpStatus: response.status,
        finalUrl: url,
        bytes: null,
        error: classified.error,
      });
    }
    const contentHash = await sha256Hex(response.body);
    if (contentHash !== item.contentHash) {
      await ports.blobs.put(pageKey(contentHash), response.body, 'text/html; charset=utf-8');
    }
    return answered({
      outcome: contentHash === item.contentHash ? 'unchanged' : 'changed',
      httpStatus: response.status,
      finalUrl: url,
      bytes: response.body.byteLength,
      error: null,
      page: {
        contentHash,
        etag: response.headers.etag ?? null,
        lastModified: response.headers['last-modified'] ?? null,
      },
    });
  }
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
 * A page that wasn't read costs only itself. Nothing is written for it and it isn't marked as
 * read, so its statements stay as they were and the next run tries again.
 */
function unread(item: ItemRef, why: string): Extracted {
  return {
    statements: NO_CHANGE,
    llm: 'skipped',
    usage: NO_USAGE,
    notes: [`${item.locator}: ${why}`],
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
    return unread(item, `the page couldn’t be read: ${message}`);
  }
  if (extraction.statements.length > MAX_PAGE_STATEMENTS) {
    return unread(
      item,
      `the page says more than ${MAX_PAGE_STATEMENTS.toLocaleString('en-US')} things, so it wasn’t read`,
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
      extractedWith:
        llm.outcome === 'failed' ? `${extractionTag(revision)}.retry` : extractionTag(revision),
      extractInputHash: llm.inputHash,
      llm: llm.detail,
      usage: llm.usage,
    }),
  );
  const notes = capped(
    extraction.rejected.map(
      (rejected) =>
        `${item.locator}: ${rejected.property} from ${rejected.path} is ${rejected.reason}`,
    ),
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

  const question = buildLlmRequest({ url: fetched.finalUrl, text: page.text, fields });
  let answer: { output: Record<string, unknown> | null; usage: LlmUsage };
  try {
    answer = await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...skipped(''),
      outcome: 'failed',
      detail: `failed: ${message}`,
      note: `${item.locator}: the LLM call failed: ${message}`,
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
