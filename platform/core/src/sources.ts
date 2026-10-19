import type { Source } from './definition';
import { pathPatternMatcher } from './robots';

/*
 * Which source a page belongs to (ADR 0006). A page keeps its address as its identity, and its
 * source is only where it lives now, so a definition that replaces a source can move the page to
 * the source that would hold it, with its history, instead of excluding it.
 */

/** The same site under its other spelling: with a leading `www.` taken off, or added. */
function otherSpelling(host: string): string {
  return host.startsWith('www.') ? host.slice('www.'.length) : `www.${host}`;
}

/** An address with its percent escapes in uppercase, as discovery keeps the pages it lists. */
function spelled(href: string): string {
  return href.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

/**
 * `sourceCovers` for many addresses against one source. What depends on the source alone is done
 * once, when this is called: respelling the pages a pages source lists, or reading a sitemap
 * source's hosts and compiling its patterns.
 */
export function sourceCoverage(source: Source): (locator: string) => boolean {
  if (source.kind === 'pages') {
    // A pages source holds an address as it lists it, fragment and all.
    const listed = new Set(
      source.pages.filter((page) => URL.canParse(page)).map((page) => spelled(new URL(page).href)),
    );
    return (locator) => URL.canParse(locator) && listed.has(spelled(new URL(locator).href));
  }
  const hosts = new Set(
    source.sitemaps.flatMap((sitemap) => {
      const host = new URL(sitemap).host;
      return [host, otherSpelling(host)];
    }),
  );
  const included = pathPatternMatcher(source.include);
  const excluded = pathPatternMatcher(source.exclude);
  return (locator) => {
    if (!URL.canParse(locator)) return false;
    const url = new URL(locator);
    if (!hosts.has(url.host)) return false;
    // Discovery keeps no fragment, and a fragment is no part of the path or query that patterns
    // read, so it makes no difference to a sitemap source.
    const path = url.pathname + url.search;
    return included(path) && !excluded(path);
  };
}

/**
 * Whether a source would hold this page: a pages source that lists its address, fragment and all,
 * or a sitemap source with a sitemap on its host (or the host's other spelling, as a sitemap may
 * redirect between them) whose patterns keep its path and query, as discovery chooses pages.
 */
export function sourceCovers(source: Source, locator: string): boolean {
  return sourceCoverage(source)(locator);
}
