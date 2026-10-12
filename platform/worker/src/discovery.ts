import {
  parseSitemap,
  selectPages,
  stableId,
  type Definition,
  type Outcome,
  type SitemapSource,
} from '@spatula/core';
import { finishListing, listPages, recordSitemapFetch } from '@spatula/store';
import type { RefreshPorts, StepRunner } from './refresh';
import { MAX_WAITS, requestThroughGate, type Requested } from './requests';
import { storable } from './text';

/*
 * Discovery: one read of a sitemap source's sitemaps, at the start of a run. Each sitemap is a
 * step: fetched through its host's gate, logged, unzipped if it's gzipped, and its pages listed as
 * the step reads it. An index names more sitemaps; the source's `follow` patterns choose which are
 * read. Only a complete read moves pages toward gone: one sitemap that fails, answers with something
 * else, or lists more than the source keeps leaves every page as it was. A sitemap is its site's, so
 * a read that a redirect carried to another site is refused: its pages would become the source's.
 */

/** How many sitemaps one source's read may fetch: its own, and those its indexes name. */
export const MAX_SITEMAPS_PER_SOURCE = 50;
/** The most of a sitemap that is read, before and after unzipping. The protocol allows 50 MB. */
export const SITEMAP_MAX_BYTES = 20 * 1024 * 1024;
const SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1';
const GZIP_MAGIC = [0x1f, 0x8b];
/** The most code units of a sitemap's own words, such as an element's name, that a reason quotes. */
const MAX_QUOTED = 200;

export interface DiscoveryContext {
  runId: string;
  datasetId: string;
  definition: Definition;
  /** The run's time, which every page this read lists carries. */
  startedAt: Date;
}

export interface SourceDiscovery {
  sitemaps: number;
  listed: number;
  added: number;
  revived: number;
  missing: number;
  gone: number;
  /** Why the read wasn't complete, or null when it was. */
  incomplete: string | null;
  notes: string[];
}

/** What one sitemap's step did. Its result is kept as JSON, so it carries counts, not pages. */
interface SitemapStep {
  /**
   * The child sitemaps an index names that the source follows. Only the first
   * MAX_SITEMAPS_PER_SOURCE + 1 are kept: no more could be read, one more shows there were too
   * many, and an index may name 50,000 addresses, which a step's result can't hold.
   */
  children: string[];
  listed: number;
  added: number;
  revived: number;
  /** Pages this sitemap matched beyond what the source keeps. */
  over: number;
  /** Why this sitemap leaves the read incomplete, or null. */
  incomplete: string | null;
  note: string | null;
}

export async function discoverSource(
  context: DiscoveryContext,
  source: SitemapSource,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<SourceDiscovery> {
  const found: SourceDiscovery = {
    sitemaps: 0,
    listed: 0,
    added: 0,
    revived: 0,
    missing: 0,
    gone: 0,
    incomplete: null,
    notes: [],
  };
  // A sitemap is read once, however often and however a definition spells it.
  const queue = [...new Set(source.sitemaps.map((url) => new URL(url).href))];
  const queued = new Set(queue);
  let over = 0;
  for (let index = 0; index < queue.length; index += 1) {
    if (index === MAX_SITEMAPS_PER_SOURCE) {
      found.incomplete ??= `it names more than ${MAX_SITEMAPS_PER_SOURCE} sitemaps`;
      break;
    }
    const read = await readWithWaits(
      context,
      source,
      queue[index]!,
      index,
      found.listed,
      step,
      ports,
    );
    found.sitemaps += 1;
    found.listed += read.listed;
    found.added += read.added;
    found.revived += read.revived;
    over += read.over;
    if (read.incomplete !== null) found.incomplete ??= read.incomplete;
    if (read.note !== null) found.notes.push(read.note);
    for (const child of read.children) {
      if (!queued.has(child)) {
        queued.add(child);
        queue.push(child);
      }
    }
  }
  if (over > 0) {
    found.incomplete ??= `it lists more than ${source.maxPages} ${source.maxPages === 1 ? 'page' : 'pages'}; only the first were kept`;
  }
  // A read that found nothing at all is far likelier a broken sitemap than a maker with no products,
  // and believing it would mark every page missing.
  if (found.listed === 0) found.incomplete ??= 'its sitemaps list no pages that match';
  if (found.incomplete === null) {
    const finished = await step.do(`listed:${source.id}`, () =>
      ports.withDb((db) =>
        finishListing(db, {
          datasetId: context.datasetId,
          sourceId: source.id,
          listedAt: context.startedAt,
        }),
      ),
    );
    found.missing = finished.missing;
    found.gone = finished.gone;
  }
  return found;
}

async function readWithWaits(
  context: DiscoveryContext,
  source: SitemapSource,
  url: string,
  index: number,
  listedSoFar: number,
  step: StepRunner,
  ports: RefreshPorts,
): Promise<SitemapStep> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await step.do(`sitemap:${source.id}:${index}:${attempt}`, () =>
      readSitemap(context, source, url, attempt, source.maxPages - listedSoFar, ports),
    );
    if (result.kind === 'done') return result.read;
    await step.sleep(`sitemap-wait:${source.id}:${index}:${attempt}`, result.retryAfterMs);
  }
}

async function readSitemap(
  context: DiscoveryContext,
  source: SitemapSource,
  url: string,
  attempt: number,
  room: number,
  ports: RefreshPorts,
): Promise<{ kind: 'later'; retryAfterMs: number } | { kind: 'done'; read: SitemapStep }> {
  const startedAt = ports.now();
  const answer = await requestThroughGate(ports, url, {
    minIntervalMs: context.definition.policy.perHostIntervalMs,
    giveUp: attempt >= MAX_WAITS,
    headers: {},
    maxBytes: SITEMAP_MAX_BYTES,
    accept: SITEMAP_ACCEPT,
  });
  if (answer.kind === 'later') return answer;

  const read = await readAnswer(answer, url);
  const log = {
    id: await stableId('fe', context.runId, 'sitemap', source.id, url, attempt),
    runId: context.runId,
    sourceId: source.id,
    url,
    finalUrl: answer.url,
    policy: answer.kind === 'denied' ? ('denied' as const) : ('allowed' as const),
    policyReason: answer.kind === 'denied' ? storable(answer.reason) : null,
    outcome: read.outcome,
    httpStatus:
      answer.kind === 'answered'
        ? answer.status
        : answer.kind === 'failed'
          ? answer.httpStatus
          : null,
    bytes: answer.kind === 'answered' ? answer.body.byteLength : null,
    startedAt,
    durationMs: ports.now().getTime() - startedAt.getTime(),
    error: read.kind === 'text' ? null : read.error,
  };
  const done = (result: Partial<SitemapStep>) => ({
    kind: 'done' as const,
    read: {
      children: [],
      listed: 0,
      added: 0,
      revived: 0,
      over: 0,
      incomplete: null,
      note: null,
      ...result,
    },
  });
  if (read.kind === 'failed') {
    await ports.withDb((db) => recordSitemapFetch(db, log));
    return done({ incomplete: `${url}: ${read.outcome} (${read.error})` });
  }

  const sitemap = parseSitemap(read.text);
  if (sitemap.kind === 'unreadable') {
    const reason = storable(sitemap.reason, MAX_QUOTED);
    await ports.withDb((db) =>
      recordSitemapFetch(db, { ...log, outcome: 'failed', error: `not a sitemap: ${reason}` }),
    );
    return done({ incomplete: `${url}: not a sitemap (${reason})` });
  }
  await ports.withDb((db) => recordSitemapFetch(db, log));
  const capped = sitemap.capped ? `${url}: it has more entries than a sitemap may hold` : null;

  if (sitemap.kind === 'index') {
    const follow = source.follow.length > 0 ? source.follow : ['/'];
    const chosen = selectPages(sitemap.entries, { include: follow, exclude: [] }, answer.url);
    return done({
      children: chosen.pages.slice(0, MAX_SITEMAPS_PER_SOURCE + 1).map((entry) => entry.loc),
      incomplete: capped,
    });
  }

  const chosen = selectPages(sitemap.entries, source, answer.url);
  const kept = chosen.pages.slice(0, Math.max(room, 0));
  const counts = await ports.withDb((db) =>
    listPages(db, {
      datasetId: context.datasetId,
      sourceId: source.id,
      recordType: source.recordType,
      listedAt: context.startedAt,
      pages: kept.map((entry) => ({
        locator: entry.loc,
        lastmod: source.useLastmod ? entry.lastmod : null,
      })),
    }),
  );
  const strays = chosen.left.elsewhere + chosen.left.unusable;
  return done({
    listed: counts.listed,
    added: counts.added,
    revived: counts.revived,
    over: chosen.pages.length - kept.length,
    incomplete: capped,
    note:
      strays === 0
        ? null
        : `${source.id}: ${url} lists ${strays} ${strays === 1 ? 'address' : 'addresses'} on other hosts or that Spatula doesn’t fetch`,
  });
}

/** The same site under its other spelling: with a leading `www.` taken off, or added. */
function otherSpelling(host: string): string {
  return host.startsWith('www.') ? host.slice('www.'.length) : `www.${host}`;
}

/** What a sitemap's answer holds: its text, or why there's none. */
async function readAnswer(
  answer: Exclude<Requested, { kind: 'later' }>,
  requested: string,
): Promise<
  | { kind: 'text'; outcome: Outcome; text: string }
  | { kind: 'failed'; outcome: Outcome; error: string }
> {
  // What a failure says can quote the site, such as the Location of a redirect that isn't an
  // address. It goes into the fetch log and a step's result, so it is cut short and made fit to
  // store, as Postgres refuses U+0000 and Workflows cap a step's result at 1 MiB.
  const failed = (outcome: Outcome, error: string) => ({
    kind: 'failed' as const,
    outcome,
    error: storable(error),
  });
  if (answer.kind === 'denied') return failed(answer.outcome, answer.reason);
  if (answer.kind === 'failed') return failed('failed', answer.error);

  // A redirect can lead anywhere, but a sitemap speaks only for its own site: the host that was
  // asked for, or its other spelling, as a store that moved to or from www. sends its sitemap.
  // Without this, a redirect would make another site's pages the source's.
  const own = new URL(requested).host;
  const host = new URL(answer.url).host;
  if (host !== own && host !== otherSpelling(own)) {
    return failed('failed', `redirected to another site, ${host}`);
  }
  const { status, headers } = answer;
  if (status === 404 || status === 410) return failed('gone', `HTTP ${status}`);
  if (headers['cf-mitigated'] === 'challenge') {
    return failed('blocked', 'the site answered with a challenge');
  }
  if ([401, 402, 403].includes(status)) return failed('blocked', `HTTP ${status}`);
  if (status < 200 || status >= 300) return failed('failed', `HTTP ${status}`);
  if (answer.truncated) return failed('failed', 'larger than 20 MB');
  const zipped = GZIP_MAGIC.every((byte, index) => answer.body[index] === byte);
  if (!zipped) {
    return { kind: 'text', outcome: 'changed', text: new TextDecoder().decode(answer.body) };
  }
  const unzipped = await gunzip(answer.body, SITEMAP_MAX_BYTES);
  return 'text' in unzipped
    ? { kind: 'text', outcome: 'changed', text: unzipped.text }
    : failed('failed', unzipped.error);
}

/**
 * A gzipped body as text, read no further than `maxBytes` once unzipped. The body is streamed in as
 * it is, and each chunk that comes out is decoded at once, so the unzipped bytes are never held
 * whole beside the text they become. A character split between two chunks waits in the decoder.
 */
async function gunzip(
  body: Uint8Array,
  maxBytes: number,
): Promise<{ text: string } | { error: string }> {
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  })
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { error: 'larger than 20 MB unzipped' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    return {
      error: `not gzip that unzips: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { text };
}
