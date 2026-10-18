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
 * Whether a source would hold this page: a pages source that lists it, or a sitemap source with a
 * sitemap on its host (or the host's other spelling, as a sitemap may redirect between them) whose
 * patterns keep its path and query, as discovery chooses pages.
 */
export function sourceCovers(source: Source, locator: string): boolean {
  if (!URL.canParse(locator)) return false;
  const url = new URL(locator);
  url.hash = '';
  if (source.kind === 'pages') {
    return source.pages.some(
      (page) => URL.canParse(page) && spelled(new URL(page).href) === spelled(url.href),
    );
  }
  const hosts = new Set(
    source.sitemaps.flatMap((sitemap) => {
      const host = new URL(sitemap).host;
      return [host, otherSpelling(host)];
    }),
  );
  if (!hosts.has(url.host)) return false;
  const path = url.pathname + url.search;
  return pathPatternMatcher(source.include)(path) && !pathPatternMatcher(source.exclude)(path);
}
