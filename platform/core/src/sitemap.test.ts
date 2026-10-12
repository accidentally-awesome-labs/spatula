import { describe, expect, it } from 'vitest';
import {
  normalizeLastmod,
  parseSitemap,
  selectPages,
  SITEMAP_MAX_DEPTH,
  SITEMAP_MAX_ENTRIES,
  type SitemapEntry,
} from './sitemap';
import { costRatio } from './testing/cost';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://maker-c.example/</loc></url>
  <url>
    <loc>https://maker-c.example/products/c1</loc>
    <lastmod>2026-10-01T04:21:54-04:00</lastmod>
    <image:image><image:loc>https://cdn.example/c1.jpg</image:loc><image:title>C1</image:title></image:image>
  </url>
  <url><loc><![CDATA[https://maker-c.example/products/c2?variant=1&size=2]]></loc><lastmod>2026-09-30</lastmod></url>
  <url><loc> https://maker-c.example/products/c3?a=1&amp;b=2 </loc><lastmod>yesterday</lastmod></url>
  <url><lastmod>2026-09-29</lastmod></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://maker-c.example/sitemap_products_1.xml?from=1&amp;to=9</loc></sitemap>
  <sitemap>
    <loc>https://maker-c.example/sitemap_pages_1.xml</loc>
    <lastmod>2026-10-12T01:00:06+02:00</lastmod>
  </sitemap>
</sitemapindex>`;

/** A urlset of `count` pages. */
const urlsetOf = (count: number) =>
  `<urlset>${Array.from({ length: count }, (_, n) => `<url><loc>https://maker-c.example/products/p${n}</loc></url>`).join('')}</urlset>`;

describe('parseSitemap', () => {
  it('reads a list of pages, with each lastmod as an ISO time', () => {
    expect(parseSitemap(URLSET)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [
        { loc: 'https://maker-c.example/', lastmod: null },
        { loc: 'https://maker-c.example/products/c1', lastmod: '2026-10-01T08:21:54.000Z' },
        {
          loc: 'https://maker-c.example/products/c2?variant=1&size=2',
          lastmod: '2026-09-30T00:00:00.000Z',
        },
        { loc: 'https://maker-c.example/products/c3?a=1&b=2', lastmod: null },
      ],
    });
  });

  it('reads an index of sitemaps', () => {
    expect(parseSitemap(INDEX)).toEqual({
      kind: 'index',
      capped: false,
      entries: [
        { loc: 'https://maker-c.example/sitemap_products_1.xml?from=1&to=9', lastmod: null },
        {
          loc: 'https://maker-c.example/sitemap_pages_1.xml',
          lastmod: '2026-10-11T23:00:06.000Z',
        },
      ],
    });
  });

  it('reads a text sitemap, one address a line', () => {
    const text =
      '\uFEFFhttps://maker-c.example/products/c1\r\n\nhttps://maker-c.example/products/c2\n';
    expect(parseSitemap(text)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [
        { loc: 'https://maker-c.example/products/c1', lastmod: null },
        { loc: 'https://maker-c.example/products/c2', lastmod: null },
      ],
    });
  });

  it('calls anything else unreadable, so a page that isn’t a sitemap can never empty a source', () => {
    expect(parseSitemap('  \n')).toEqual({ kind: 'unreadable', reason: 'it is empty' });
    expect(parseSitemap('<!doctype html><html><body>Not found</body></html>')).toEqual({
      kind: 'unreadable',
      reason: 'its root element is <html>, not a sitemap’s',
    });
    expect(parseSitemap('Not found')).toEqual({
      kind: 'unreadable',
      reason: 'line 1 isn’t an address',
    });
    expect(parseSitemap('<?xml version="1.0"?>')).toEqual({
      kind: 'unreadable',
      reason: 'it holds no XML elements',
    });
    expect(parseSitemap(`<urlset>${'<url>'.repeat(SITEMAP_MAX_DEPTH)}`)).toEqual({
      kind: 'unreadable',
      reason: 'it nests elements more than 64 deep',
    });
  });

  it('stops at 50,000 entries, and says it did', () => {
    const read = parseSitemap(urlsetOf(SITEMAP_MAX_ENTRIES + 1));
    expect(read).toMatchObject({ kind: 'urlset', capped: true });
    if (read.kind === 'unreadable') return;
    expect(read.entries).toHaveLength(SITEMAP_MAX_ENTRIES);
    const lines = Array.from(
      { length: SITEMAP_MAX_ENTRIES + 1 },
      (_, n) => `https://maker-c.example/p${n}`,
    ).join('\n');
    expect(parseSitemap(lines)).toMatchObject({ kind: 'urlset', capped: true });
  });

  it('takes time in proportion to its length, however it nests or closes', () => {
    expect(
      costRatio(
        () => parseSitemap(urlsetOf(400)),
        () => parseSitemap(urlsetOf(40_000)),
        100,
      ),
    ).toBeLessThan(4);
    const deep = (levels: number) => () => parseSitemap(`<urlset>${'<x>'.repeat(levels)}`);
    expect(costRatio(deep(5_000), deep(500_000), 100)).toBeLessThan(4);
    const stray = (count: number) => () => parseSitemap(`<urlset><url>${'</nope>'.repeat(count)}`);
    expect(costRatio(stray(2_000), stray(200_000), 100)).toBeLessThan(4);
  });
});

describe('normalizeLastmod', () => {
  it('reads the W3C forms sitemaps use, and nothing else', () => {
    expect(normalizeLastmod('2026-10-12')).toBe('2026-10-12T00:00:00.000Z');
    expect(normalizeLastmod(' 2026-10-12T04:21:54-04:00 ')).toBe('2026-10-12T08:21:54.000Z');
    expect(normalizeLastmod('2026-10-12T08:21:54.501Z')).toBe('2026-10-12T08:21:54.501Z');
    expect(normalizeLastmod('2026-10-12T04:21-04:00')).toBe('2026-10-12T08:21:00.000Z');
    for (const bad of ['', 'yesterday', '2026', '2026-10', '2026-13-40', '12/10/2026']) {
      expect(normalizeLastmod(bad)).toBeNull();
    }
  });
});

describe('selectPages', () => {
  it('keeps the matching https pages on the sitemap’s own host, once each', () => {
    const entries: SitemapEntry[] = [
      { loc: 'https://maker-c.example/', lastmod: null },
      { loc: 'https://maker-c.example/products/c1', lastmod: '2026-10-01T00:00:00.000Z' },
      { loc: 'https://maker-c.example/products/c1#reviews', lastmod: '2026-10-05T00:00:00.000Z' },
      { loc: 'https://maker-c.example/products/c1-gift-card', lastmod: null },
      { loc: 'https://maker-c.example/products/c2?variant=1', lastmod: null },
      { loc: 'http://maker-c.example/products/c3', lastmod: null },
      { loc: 'https://cdn.maker-c.example/products/c4', lastmod: null },
      { loc: 'https://intranet.local/products/c5', lastmod: null },
      { loc: 'not an address', lastmod: null },
    ];
    const chosen = selectPages(
      entries,
      { include: ['/products/*'], exclude: ['/products/*-gift-card'] },
      'https://maker-c.example/sitemap.xml',
    );
    expect(chosen).toEqual({
      pages: [
        { loc: 'https://maker-c.example/products/c1', lastmod: '2026-10-05T00:00:00.000Z' },
        { loc: 'https://maker-c.example/products/c2?variant=1', lastmod: null },
      ],
      left: { elsewhere: 1, unusable: 3, unmatched: 2, repeated: 1 },
    });
  });
});
