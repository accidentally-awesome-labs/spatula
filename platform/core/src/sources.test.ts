import { describe, expect, it } from 'vitest';
import { parseDefinition, type Source } from './definition';
import { sourceCoverage, sourceCovers } from './sources';

const evidence = {
  robots: '2026-10-18',
  terms: {
    url: 'https://maker.example/terms',
    checked: '2026-10-18',
    automatedAccess: 'not-mentioned',
  },
};

/** The sources of a small definition, parsed, so their defaults are filled in. */
function sourcesOf(raw: unknown[]): Source[] {
  const result = parseDefinition({
    dataset: 'covers',
    recordTypes: {
      product: {
        pack: 'products/product',
        identity: { identifiers: ['gtins'], keys: [['brand', 'name']] },
        fields: {
          brand: { type: 'text', required: true, maxLength: 80 },
          name: { type: 'text', required: true, maxLength: 120 },
          gtins: { type: 'gtin', list: true, identifier: true },
        },
      },
    },
    sources: raw,
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition.sources;
}

const [pages, sitemap, sectioned] = sourcesOf([
  {
    id: 'listed',
    kind: 'pages',
    recordType: 'product',
    pages: ['https://maker.example/products/a1', 'https://maker.example/Products/%e2%84%a2'],
    fixed: { brand: 'Maker' },
    evidence,
  },
  {
    id: 'mapped',
    kind: 'sitemap',
    recordType: 'product',
    sitemaps: ['https://www.maker.example/sitemap.xml'],
    include: ['/products/*'],
    exclude: ['/products/*-gift-card'],
    fixed: { brand: 'Maker' },
    evidence,
  },
  {
    id: 'sectioned',
    kind: 'pages',
    recordType: 'product',
    pages: ['https://maker.example/products/a3#specs'],
    fixed: { brand: 'Maker' },
    evidence,
  },
]);

describe('sourceCovers', () => {
  it('covers a page a pages source lists, in either spelling of its address', () => {
    expect(sourceCovers(pages!, 'https://maker.example/products/a1')).toBe(true);
    expect(sourceCovers(pages!, 'https://MAKER.example/products/a1')).toBe(true);
    expect(sourceCovers(pages!, 'https://maker.example/Products/%E2%84%A2')).toBe(true);
    expect(sourceCovers(pages!, 'https://maker.example/products/a2')).toBe(false);
  });

  it('covers a page on a sitemap’s host, or its other spelling, that its patterns keep', () => {
    expect(sourceCovers(sitemap!, 'https://www.maker.example/products/a1')).toBe(true);
    expect(sourceCovers(sitemap!, 'https://maker.example/products/a1')).toBe(true);
    expect(sourceCovers(sitemap!, 'https://maker.example/products/a1?variant=2')).toBe(true);
  });

  it('doesn’t cover a page its patterns leave out, or one on another host', () => {
    expect(sourceCovers(sitemap!, 'https://maker.example/pages/about')).toBe(false);
    expect(sourceCovers(sitemap!, 'https://maker.example/products/card-gift-card')).toBe(false);
    expect(sourceCovers(sitemap!, 'https://other.example/products/a1')).toBe(false);
    expect(sourceCovers(sitemap!, 'not an address')).toBe(false);
  });

  it('covers a page a pages source lists with a fragment only with that fragment', () => {
    expect(sourceCovers(sectioned!, 'https://maker.example/products/a3#specs')).toBe(true);
    expect(sourceCovers(sectioned!, 'https://maker.example/products/a3')).toBe(false);
    expect(sourceCovers(sectioned!, 'https://maker.example/products/a3#reviews')).toBe(false);
  });

  it('covers a sitemap’s page whatever its fragment, since discovery keeps none', () => {
    expect(sourceCovers(sitemap!, 'https://maker.example/products/a1#top')).toBe(true);
    expect(sourceCovers(sitemap!, 'https://maker.example/products/a1?variant=2#top')).toBe(true);
    expect(sourceCovers(sitemap!, 'https://maker.example/pages/about#top')).toBe(false);
  });
});

describe('sourceCoverage', () => {
  it('answers as sourceCovers does, for each address asked of the same prepared source', () => {
    const asked: [Source, string, boolean][] = [
      [pages!, 'https://maker.example/products/a1', true],
      [pages!, 'https://MAKER.example/products/a1', true],
      [pages!, 'https://maker.example/Products/%E2%84%A2', true],
      [pages!, 'https://maker.example/products/a2', false],
      [sectioned!, 'https://maker.example/products/a3#specs', true],
      [sectioned!, 'https://maker.example/products/a3', false],
      [sitemap!, 'https://www.maker.example/products/a1', true],
      [sitemap!, 'https://maker.example/products/a1?variant=2#top', true],
      [sitemap!, 'https://maker.example/products/card-gift-card', false],
      [sitemap!, 'https://other.example/products/a1', false],
      [sitemap!, 'not an address', false],
    ];
    const prepared = new Map([pages!, sectioned!, sitemap!].map((s) => [s, sourceCoverage(s)]));
    for (const [source, address, covered] of asked) {
      expect(prepared.get(source)!(address), `${source.id}, prepared, at ${address}`).toBe(covered);
      expect(sourceCovers(source, address), `${source.id} at ${address}`).toBe(covered);
    }
  });
});
