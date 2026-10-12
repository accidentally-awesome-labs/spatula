import { Parser } from 'htmlparser2';
import { addressError } from './definition';
import { pathPatternMatches } from './robots';

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

/** What the XML reader has seen so far. It's an object so the parser's callbacks can share it. */
interface Reading {
  root: string | null;
  depth: number;
  entries: SitemapEntry[];
  capped: boolean;
  tooDeep: boolean;
  /** The <url> or <sitemap> being read, and which of its fields the text belongs to. */
  entry: { loc: string; lastmod: string } | null;
  field: 'loc' | 'lastmod' | null;
}

/** Thrown from the parser's callbacks, which run inside `write`, to stop reading. */
class StopReading extends Error {}

function xmlSitemap(body: string): SitemapRead {
  const reading: Reading = {
    root: null,
    depth: 0,
    entries: [],
    capped: false,
    tooDeep: false,
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
          reading.tooDeep = true;
          throw new StopReading();
        }
        const local = name.slice(name.indexOf(':') + 1).toLowerCase();
        if (reading.depth === 1) reading.root = local;
        else if (reading.depth === 2 && (local === 'url' || local === 'sitemap')) {
          reading.entry = { loc: '', lastmod: '' };
        } else if (reading.depth === 3 && reading.entry !== null) {
          reading.field = local === 'loc' || local === 'lastmod' ? local : null;
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
    parser.end();
  } catch (error) {
    if (!(error instanceof StopReading)) throw error;
  }
  if (reading.tooDeep) {
    return {
      kind: 'unreadable',
      reason: `it nests elements more than ${SITEMAP_MAX_DEPTH} deep`,
    };
  }
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
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface PageSelection {
  pages: SitemapEntry[];
  /** How many entries were left out, and why. */
  left: { elsewhere: number; unusable: number; unmatched: number; repeated: number };
}

/**
 * The entries a source keeps: https addresses on the sitemap's own host that Spatula may fetch,
 * whose path and query match an include pattern and no exclude pattern. Each address is kept once,
 * without its fragment, with the latest lastmod given for it. An index's child sitemaps are chosen
 * the same way, with the source's `follow` patterns as the includes.
 */
export function selectPages(
  entries: readonly SitemapEntry[],
  patterns: { include: readonly string[]; exclude: readonly string[] },
  sitemapUrl: string,
): PageSelection {
  const host = new URL(sitemapUrl).host;
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
    const wanted =
      patterns.include.some((pattern) => pathPatternMatches(pattern, path)) &&
      !patterns.exclude.some((pattern) => pathPatternMatches(pattern, path));
    if (!wanted) {
      left.unmatched += 1;
      continue;
    }
    const earlier = kept.get(url.href);
    if (earlier === undefined) {
      kept.set(url.href, { loc: url.href, lastmod: entry.lastmod });
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
