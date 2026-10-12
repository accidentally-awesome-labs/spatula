import { Parser } from 'htmlparser2';
import { addressError } from './definition';
import { pathPatternMatcher } from './robots';

/*
 * Sitemaps, as sitemaps.org describes them: an XML list of pages (a urlset), an XML list of other
 * sitemaps (an index), or a text file with one address a line. A sitemap is what a site says it
 * offers, so it's evidence, never an instruction: only https addresses on the sitemap's own host
 * that match a source's patterns become pages, and robots.txt is still asked before each of them is
 * fetched. Anything that isn't plainly a sitemap is unreadable, never empty: a soft 404 read as an
 * empty sitemap would mark every page of a source missing. Gzip is the Worker's business; this
 * reads text.
 */

/** The most entries a sitemap holds under the protocol. Past it, the rest are left unread. */
export const SITEMAP_MAX_ENTRIES = 50_000;
/** A sitemap nests three elements deep. A file nested deeper than this isn't one. */
export const SITEMAP_MAX_DEPTH = 64;
/** The protocol's limit on an address's length. */
const MAX_LOC = 2048;

export interface SitemapEntry {
  loc: string;
  /** When the site says the page last changed, as an ISO time; null when it says nothing usable. */
  lastmod: string | null;
}

export type SitemapRead =
  | { kind: 'urlset' | 'index'; entries: SitemapEntry[]; capped: boolean }
  | { kind: 'unreadable'; reason: string };

export function parseSitemap(text: string): SitemapRead {
  // trimStart takes a byte order mark too: ECMAScript counts U+FEFF as white space.
  const body = text.trimStart();
  if (body === '') return { kind: 'unreadable', reason: 'it is empty' };
  return body.startsWith('<') ? xmlSitemap(body) : textSitemap(body);
}

function textSitemap(body: string): SitemapRead {
  const entries: SitemapEntry[] = [];
  const lines = body.split(/\r\n|\r|\n/u);
  for (const [index, line] of lines.entries()) {
    const loc = line.trim();
    if (loc === '') continue;
    // A text sitemap holds addresses and nothing else; any other line means this is something
    // else, such as an error page in plain text.
    if (!/^https?:\/\/\S+$/iu.test(loc) || loc.length > MAX_LOC) {
      return { kind: 'unreadable', reason: `line ${index + 1} isn’t an address` };
    }
    if (entries.length === SITEMAP_MAX_ENTRIES) return { kind: 'urlset', entries, capped: true };
    entries.push({ loc, lastmod: null });
  }
  return { kind: 'urlset', entries, capped: false };
}

/** The element that holds one entry, under each kind of root. */
const ENTRY_ELEMENT = new Map([
  ['urlset', 'url'],
  ['sitemapindex', 'sitemap'],
]);

/** What the XML reader has seen so far. It's an object so the parser's callbacks can share it. */
interface Reading {
  /** The root element's name in lowercase, without its prefix. */
  root: string | null;
  /** The root's prefix as written. Only elements with the same one are the sitemap's own. */
  prefix: string;
  /** What this root's entries are called, if it is a sitemap's root. */
  entryElement: string | null;
  depth: number;
  entries: SitemapEntry[];
  capped: boolean;
  /** Why the file is refused, once it has been. */
  refusal: string | null;
  /**
   * The <url> or <sitemap> being read, with the text of its fields so far and whether each field
   * has started: an entry keeps the first of each, and a later one is ignored.
   */
  entry: {
    loc: string;
    lastmod: string;
    started: { loc: boolean; lastmod: boolean };
  } | null;
  /** Which of the entry's fields the text being read belongs to. */
  field: 'loc' | 'lastmod' | null;
}

/** Thrown from the parser's callbacks, which run inside `write`, to stop reading. */
class StopReading extends Error {}

function xmlSitemap(body: string): SitemapRead {
  const reading: Reading = {
    root: null,
    prefix: '',
    entryElement: null,
    depth: 0,
    entries: [],
    capped: false,
    refusal: null,
    entry: null,
    field: null,
  };
  // The parser keeps a stack of open elements, and searches it at each end tag. Stopping at 64
  // levels keeps that stack short, so the read stays linear however the file nests or closes.
  const parser = new Parser(
    {
      onopentag(name) {
        reading.depth += 1;
        if (reading.depth > SITEMAP_MAX_DEPTH) {
          reading.refusal = `it nests elements more than ${SITEMAP_MAX_DEPTH} deep`;
          throw new StopReading();
        }
        // A name is `prefix:local` or just `local`. The local name compares in lowercase, but the
        // prefix as written.
        const colon = name.indexOf(':');
        const prefix = colon === -1 ? '' : name.slice(0, colon);
        const local = name.slice(colon + 1).toLowerCase();
        // Only elements written with the root's prefix are the sitemap's own. An extension's, such
        // as the <image:loc> inside a <url>, is not.
        const ours = prefix === reading.prefix;
        if (reading.depth === 1) {
          if (reading.root !== null) {
            reading.refusal = 'it has more than one root element';
            throw new StopReading();
          }
          reading.root = local;
          reading.prefix = prefix;
          reading.entryElement = ENTRY_ELEMENT.get(local) ?? null;
        } else if (ours && reading.depth === 2 && local === reading.entryElement) {
          reading.entry = { loc: '', lastmod: '', started: { loc: false, lastmod: false } };
        } else if (
          ours &&
          reading.depth === 3 &&
          reading.entry !== null &&
          (local === 'loc' || local === 'lastmod')
        ) {
          // The first of each field is the entry's. Text in a later one is ignored.
          if (!reading.entry.started[local]) {
            reading.entry.started[local] = true;
            reading.field = local;
          }
        }
      },
      ontext(text) {
        const { entry, field } = reading;
        // Text past the protocol's limit is never kept: such an address is dropped below.
        if (entry !== null && field !== null && entry[field].length <= MAX_LOC) {
          entry[field] += text.slice(0, MAX_LOC + 1);
        }
      },
      onclosetag() {
        if (reading.depth === 3) reading.field = null;
        else if (reading.depth === 2 && reading.entry !== null) {
          const loc = reading.entry.loc.trim();
          if (loc !== '' && loc.length <= MAX_LOC) {
            if (reading.entries.length === SITEMAP_MAX_ENTRIES) {
              reading.capped = true;
              throw new StopReading();
            }
            reading.entries.push({ loc, lastmod: normalizeLastmod(reading.entry.lastmod) });
          }
          reading.entry = null;
        }
        reading.depth -= 1;
      },
    },
    { xmlMode: true },
  );
  try {
    parser.write(body);
    // `end` closes every element still open, so without this a file cut off after its root would
    // read as a whole list, even an empty one. A whole sitemap has closed its root by now. A read
    // that stopped early, at the cap, the depth limit, or a second root, never gets here.
    if (reading.depth > 0) {
      return { kind: 'unreadable', reason: 'it ends before its root element closes' };
    }
    parser.end();
  } catch (error) {
    if (!(error instanceof StopReading)) throw error;
  }
  if (reading.refusal !== null) return { kind: 'unreadable', reason: reading.refusal };
  const { root, entries, capped } = reading;
  if (root === 'urlset') return { kind: 'urlset', entries, capped };
  if (root === 'sitemapindex') return { kind: 'index', entries, capped };
  return {
    kind: 'unreadable',
    reason:
      root === null ? 'it holds no XML elements' : `its root element is <${root}>, not a sitemap’s`,
  };
}

/** The W3C datetime forms sitemaps use: a date, or a date and a time with its zone. */
const W3C_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

/** A lastmod as an ISO time in UTC, or null for anything that isn't a W3C datetime. */
export function normalizeLastmod(text: string): string | null {
  const value = text.trim();
  if (value.length > 40 || !W3C_DATETIME.test(value)) return null;
  // Date.parse rolls a day its month lacks into the next month (2026-02-30 reads as March 2), so
  // the date's parts must come back out of Date.UTC as they went in. Date.UTC reads the years 0 to
  // 99 as 1900 to 1999, so those fail too, and no sitemap means them.
  const [year = 0, month = 0, day = 0] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const sameDate =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const ms = Date.parse(value);
  if (!sameDate || !Number.isFinite(ms)) return null;
  // An offset can carry a time over the edge of the years 0000 to 9999, where toISOString writes a
  // sign and six digits, and ISO times no longer compare as text.
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/u.test(iso) ? iso : null;
}

export interface PageSelection {
  pages: SitemapEntry[];
  /** How many entries were left out, and why. */
  left: { elsewhere: number; unusable: number; unmatched: number; repeated: number };
}

/**
 * The entries a source keeps: https addresses on the sitemap's own host that Spatula may fetch,
 * whose path and query match an include pattern and no exclude pattern. Each address is kept once,
 * with the latest lastmod given for it, in one spelling: without its fragment, and with its percent
 * escapes in uppercase, as robots.txt compares paths. An index's child sitemaps are chosen the same
 * way, with the source's `follow` patterns as the includes.
 */
export function selectPages(
  entries: readonly SitemapEntry[],
  patterns: { include: readonly string[]; exclude: readonly string[] },
  sitemapUrl: string,
): PageSelection {
  const host = new URL(sitemapUrl).host;
  // Each pattern is prepared once here, not again for every address.
  const included = pathPatternMatcher(patterns.include);
  const excluded = pathPatternMatcher(patterns.exclude);
  const kept = new Map<string, SitemapEntry>();
  const left = { elsewhere: 0, unusable: 0, unmatched: 0, repeated: 0 };
  for (const entry of entries) {
    const url = URL.canParse(entry.loc) ? new URL(entry.loc) : null;
    if (url === null || url.protocol !== 'https:' || addressError(url) !== null) {
      left.unusable += 1;
      continue;
    }
    if (url.host !== host) {
      left.elsewhere += 1;
      continue;
    }
    url.hash = '';
    const path = url.pathname + url.search;
    const wanted = included(path) && !excluded(path);
    if (!wanted) {
      left.unmatched += 1;
      continue;
    }
    const href = url.href.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
    const earlier = kept.get(href);
    if (earlier === undefined) {
      kept.set(href, { loc: href, lastmod: entry.lastmod });
      continue;
    }
    left.repeated += 1;
    // ISO times in UTC compare as text.
    if (entry.lastmod !== null && (earlier.lastmod === null || entry.lastmod > earlier.lastmod)) {
      earlier.lastmod = entry.lastmod;
    }
  }
  return { pages: [...kept.values()], left };
}
