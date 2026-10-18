import { describe, expect, it } from 'vitest';
import { parseDefinition, type Source } from './definition';
import { sourceCovers } from './sources';

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

const [pages, sitemap] = sourcesOf([
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
});
