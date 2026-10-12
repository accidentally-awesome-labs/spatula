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

/** A text sitemap of `count` addresses. */
const linesOf = (count: number) =>
  Array.from({ length: count }, (_, n) => `https://maker-c.example/p${n}`).join('\n');

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

  it('reads <url> only under <urlset>, and <sitemap> only under <sitemapindex>', () => {
    const page = '<url><loc>https://maker-c.example/products/c1</loc></url>';
    const child = '<sitemap><loc>https://maker-c.example/sitemap_products_1.xml</loc></sitemap>';
    expect(parseSitemap(`<sitemapindex>${page}</sitemapindex>`)).toEqual({
      kind: 'index',
      capped: false,
      entries: [],
    });
    expect(parseSitemap(`<urlset>${child}</urlset>`)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [],
    });
  });

  it('reads only the elements that share the root’s prefix, whatever it is', () => {
    const prefixed = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"
                 xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <sm:url>
        <sm:loc>https://maker-c.example/products/c1</sm:loc>
        <image:loc>https://cdn.example/c1.jpg</image:loc>
        <sm:lastmod>2026-10-01</sm:lastmod>
      </sm:url>
    </sm:urlset>`;
    expect(parseSitemap(prefixed)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [
        { loc: 'https://maker-c.example/products/c1', lastmod: '2026-10-01T00:00:00.000Z' },
      ],
    });
    // Elements of another namespace aren't the sitemap's, even when they are named like its own.
    const strangers = [
      '<sm:urlset xmlns:sm="x"><url><loc>https://maker-c.example/c1</loc></url></sm:urlset>',
      '<urlset xmlns:o="x"><o:url><o:loc>https://maker-c.example/c1</o:loc></o:url></urlset>',
    ];
    for (const text of strangers) {
      expect(parseSitemap(text)).toEqual({ kind: 'urlset', capped: false, entries: [] });
    }
  });

  it('does not glue an extension’s address onto the page’s own', () => {
    const own = '<loc>https://maker-c.example/a</loc>';
    const extension = '<image:loc>https://cdn.example/x.jpg</image:loc>';
    const text = `<urlset xmlns:image="x"><url>${own}${extension}</url></urlset>`;
    expect(parseSitemap(text)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [{ loc: 'https://maker-c.example/a', lastmod: null }],
    });
  });

  it('does not take an extension’s <loc> before the page’s own for its address', () => {
    // Placed after the page's own <loc>, the first-<loc> rule would hide it anyway. Placed before
    // it, only the prefix keeps it out.
    const extension = '<image:loc>https://cdn.example/x.jpg</image:loc>';
    const own = '<loc>https://maker-c.example/a</loc>';
    const text = `<urlset xmlns:image="x"><url>${extension}${own}</url></urlset>`;
    expect(parseSitemap(text)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [{ loc: 'https://maker-c.example/a', lastmod: null }],
    });
  });

  it('does not take an element of another namespace named <url> for an entry', () => {
    // The <loc> inside it has the root's prefix, so only the prefix of the <url> keeps it out.
    const text = '<urlset xmlns:o="x"><o:url><loc>https://maker-c.example/a</loc></o:url></urlset>';
    expect(parseSitemap(text)).toEqual({ kind: 'urlset', capped: false, entries: [] });
  });

  it('keeps an entry’s first <loc> and first <lastmod>, and joins the text of each', () => {
    // The first <loc> arrives as several pieces of text (around an entity and a CDATA section),
    // and every one of them is part of it. Only a later element is ignored.
    const text = `<urlset>
      <url>
        <loc>https://maker-c.example/products/c1?a=1&amp;b=2<![CDATA[&c=3]]></loc>
        <loc>https://maker-c.example/products/other</loc>
        <lastmod>2026-09-30</lastmod>
        <lastmod>2026-10-01</lastmod>
      </url>
    </urlset>`;
    expect(parseSitemap(text)).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [
        {
          loc: 'https://maker-c.example/products/c1?a=1&b=2&c=3',
          lastmod: '2026-09-30T00:00:00.000Z',
        },
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

  it('calls a file that ends before its root closes unreadable, never a whole list', () => {
    const cutOff = { kind: 'unreadable', reason: 'it ends before its root element closes' };
    const page = (n: number) => `<url><loc>https://maker-c.example/products/p${n}</loc></url>`;
    // Nothing after the root's start.
    expect(parseSitemap('<?xml version="1.0"?><urlset xmlns="x">')).toEqual(cutOff);
    // A generator that died after writing the root.
    expect(
      parseSitemap('<urlset>\n<br />\n<b>Fatal error</b>: Allowed memory size exhausted'),
    ).toEqual(cutOff);
    // Two entries, then a cut through the third one's address, which isn't a whole address.
    const third = '<url><loc>https://maker-c.example/products/p3';
    expect(parseSitemap(`<urlset>${page(1)}${page(2)}${third}`)).toEqual(cutOff);
    // An index is cut off the same way, between its children.
    const child = '<sitemap><loc>https://maker-c.example/sitemap_products_1.xml</loc></sitemap>';
    expect(parseSitemap(`<sitemapindex>${child}`)).toEqual(cutOff);
    // A read that stops at the cap or the depth limit never reaches the end of the file, so
    // neither is called cut off.
    const capped = urlsetOf(SITEMAP_MAX_ENTRIES + 1).replace('</urlset>', '');
    expect(parseSitemap(capped)).toMatchObject({ kind: 'urlset', capped: true });
    expect(parseSitemap(`<urlset>${'<x>'.repeat(SITEMAP_MAX_DEPTH)}`)).toEqual({
      kind: 'unreadable',
      reason: 'it nests elements more than 64 deep',
    });
  });

  it('calls a file with more than one root element unreadable', () => {
    const reason = 'it has more than one root element';
    const page = '<url><loc>https://maker-c.example/products/c1</loc></url>';
    expect(parseSitemap(`<html>${page}</html><urlset></urlset>`)).toEqual({
      kind: 'unreadable',
      reason,
    });
    expect(parseSitemap(`<urlset>${page}</urlset><urlset></urlset>`)).toEqual({
      kind: 'unreadable',
      reason,
    });
    // Comments, instructions, and white space around the root are not elements.
    expect(
      parseSitemap(`<?xml version="1.0"?>\n<!-- made by hand -->\n<urlset>${page}</urlset>\n`),
    ).toMatchObject({ kind: 'urlset', capped: false });
  });

  it('reads an empty list as a whole one, and a file nested exactly 64 deep', () => {
    for (const text of ['<urlset/>', '<urlset></urlset>', '<urlset xmlns="x">\n</urlset>\n']) {
      expect(parseSitemap(text)).toEqual({ kind: 'urlset', capped: false, entries: [] });
    }
    expect(parseSitemap('<sitemapindex/>')).toEqual({ kind: 'index', capped: false, entries: [] });
    const nested = (levels: number) =>
      `<urlset>${'<x>'.repeat(levels - 1)}${'</x>'.repeat(levels - 1)}</urlset>`;
    expect(parseSitemap(nested(SITEMAP_MAX_DEPTH))).toEqual({
      kind: 'urlset',
      capped: false,
      entries: [],
    });
    expect(parseSitemap(nested(SITEMAP_MAX_DEPTH + 1))).toEqual({
      kind: 'unreadable',
      reason: 'it nests elements more than 64 deep',
    });
  });

  it('stops at 50,000 entries, and says it did', () => {
    const read = parseSitemap(urlsetOf(SITEMAP_MAX_ENTRIES + 1));
    expect(read).toMatchObject({ kind: 'urlset', capped: true });
    if (read.kind === 'unreadable') return;
    expect(read.entries).toHaveLength(SITEMAP_MAX_ENTRIES);
    const lines = parseSitemap(linesOf(SITEMAP_MAX_ENTRIES + 1));
    expect(lines).toMatchObject({ kind: 'urlset', capped: true });
    if (lines.kind === 'unreadable') return;
    expect(lines.entries).toHaveLength(SITEMAP_MAX_ENTRIES);
  });

  it('reads exactly 50,000 entries in full, in either form', () => {
    const xml = parseSitemap(urlsetOf(SITEMAP_MAX_ENTRIES));
    expect(xml).toMatchObject({ kind: 'urlset', capped: false });
    if (xml.kind === 'unreadable') return;
    expect(xml.entries).toHaveLength(SITEMAP_MAX_ENTRIES);
    const lines = parseSitemap(linesOf(SITEMAP_MAX_ENTRIES));
    expect(lines).toMatchObject({ kind: 'urlset', capped: false });
    if (lines.kind === 'unreadable') return;
    expect(lines.entries).toHaveLength(SITEMAP_MAX_ENTRIES);
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
    // An end tag with nothing to close is looked for on the parser's whole stack of open elements.
    // First under a stack nearly as deep as the cap lets one get: each costs the same however many.
    const stray = (count: number) => () =>
      parseSitemap(`<urlset>${'<x>'.repeat(60)}${'</nope>'.repeat(count)}`);
    expect(costRatio(stray(2_000), stray(200_000), 100)).toBeLessThan(4);
    // Then under a stack as deep as the file is long, which only the cap keeps from growing. A
    // reader without it takes the square of the length here, so these sizes are kept small.
    const strayAndDeep = (size: number) => () =>
      parseSitemap(`<urlset>${'<x>'.repeat(size)}${'</nope>'.repeat(size)}`);
    expect(costRatio(strayAndDeep(500), strayAndDeep(50_000), 100)).toBeLessThan(4);
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

  it('refuses a day its month doesn’t have, rather than rolling it into the next month', () => {
    // Date.parse rolls each of these into the next month.
    for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2100-02-29']) {
      expect(normalizeLastmod(bad)).toBeNull();
      expect(normalizeLastmod(`${bad}T10:00:00Z`)).toBeNull();
    }
    expect(normalizeLastmod('2026-02-28')).toBe('2026-02-28T00:00:00.000Z');
    expect(normalizeLastmod('2028-02-29')).toBe('2028-02-29T00:00:00.000Z');
    expect(normalizeLastmod('2000-02-29T23:59:59Z')).toBe('2000-02-29T23:59:59.000Z');
  });

  it('refuses a time outside the years 0000 to 9999, so that ISO times compare as text', () => {
    // Date.parse carries these over the edge of the year range, to +010000-01-01 and -000001-12-31.
    expect(normalizeLastmod('9999-12-31T23:59:59-01:00')).toBeNull();
    expect(normalizeLastmod('0000-01-01T00:00:00+01:00')).toBeNull();
    expect(normalizeLastmod('9999-12-31T23:59:59Z')).toBe('9999-12-31T23:59:59.000Z');
    expect(normalizeLastmod('9999-12-31T23:59:59+01:00')).toBe('9999-12-31T22:59:59.000Z');
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

  it('counts an address once, whatever the case of its percent escapes', () => {
    const lower = {
      loc: 'https://maker-c.example/products/%c3%a4?q=%e2%82%ac',
      lastmod: '2026-10-01T00:00:00.000Z',
    };
    const upper = {
      loc: 'https://maker-c.example/products/%C3%A4?q=%E2%82%AC',
      lastmod: '2026-10-05T00:00:00.000Z',
    };
    const patterns = { include: ['/products/'], exclude: [] };
    // Either way round, the page keeps one spelling, so it is the same page in every read.
    const chosen = {
      pages: [{ loc: upper.loc, lastmod: upper.lastmod }],
      left: { elsewhere: 0, unusable: 0, unmatched: 0, repeated: 1 },
    };
    const sitemapUrl = 'https://maker-c.example/sitemap.xml';
    expect(selectPages([lower, upper], patterns, sitemapUrl)).toEqual(chosen);
    expect(selectPages([upper, lower], patterns, sitemapUrl)).toEqual(chosen);
  });

  describe('at the edge of the sitemap’s host', () => {
    const none = { elsewhere: 0, unusable: 0, unmatched: 0, repeated: 0 };
    const choose = (loc: string) =>
      selectPages(
        [{ loc, lastmod: null }],
        { include: ['/'], exclude: [] },
        'https://maker-c.example/sitemap.xml',
      );
    // These two are written from their code points, because neither looks like what it is.
    const cyrillicEs = String.fromCodePoint(0x441);
    const fullWidth = (text: string) =>
      [...text].map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');

    it.each([
      ['credentials', 'https://user:secret@maker-c.example/products/x'],
      ['an IPv4 address', 'https://127.0.0.1/products/x'],
      ['an IPv4 address in hexadecimal', 'https://0x7f.1/products/x'],
      ['an IPv6 address', 'https://[::1]/products/x'],
      ['localhost with a trailing dot', 'https://localhost./products/x'],
      ['a name in .internal', 'https://printer.internal/products/x'],
    ])('leaves out %s as an address Spatula won’t fetch', (_kind, loc) => {
      expect(choose(loc)).toEqual({ pages: [], left: { ...none, unusable: 1 } });
    });

    it.each([
      ['another port', 'https://maker-c.example:8443/products/x'],
      ['a trailing dot on the host', 'https://maker-c.example./products/x'],
      ['a look-alike letter in the host', `https://maker-${cyrillicEs}.example/products/x`],
    ])('leaves out %s as another host', (_kind, loc) => {
      expect(choose(loc)).toEqual({ pages: [], left: { ...none, elsewhere: 1 } });
    });

    it.each([
      ['an uppercase host', 'https://MAKER-C.EXAMPLE/products/x'],
      ['the default port', 'https://maker-c.example:443/products/x'],
      ['full-width letters', `https://${fullWidth('maker-c')}.${fullWidth('example')}/products/x`],
      ['a percent-encoded dot in the host', 'https://maker-c%2Eexample/products/x'],
      ['backslashes for slashes', 'https://maker-c.example\\products\\x'],
      ['a tab in the host', 'https://maker-c.exam\tple/products/x'],
    ])('keeps %s as the sitemap’s own address, normalized', (_kind, loc) => {
      expect(choose(loc)).toEqual({
        pages: [{ loc: 'https://maker-c.example/products/x', lastmod: null }],
        left: none,
      });
    });
  });
});
