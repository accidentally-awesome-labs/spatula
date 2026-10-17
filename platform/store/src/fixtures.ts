import { parseDefinition, type Definition } from '@spatula/core';

const evidence = (host: string) => ({
  robots: '2026-10-09',
  terms: {
    url: `https://${host}/policies/terms-of-service`,
    checked: '2026-10-09',
    automatedAccess: 'not-mentioned',
  },
});

/** A small, valid dataset for tests: two makers on two hosts, three product pages. */
export function testDefinition(dataset = 'test-products'): Definition {
  const result = parseDefinition({
    dataset,
    recordTypes: {
      product: {
        pack: 'products/product',
        identity: { identifiers: ['gtins', 'mpns'], keys: [['brand', 'name']] },
        fields: {
          brand: { type: 'text', required: true, maxLength: 80 },
          name: { type: 'text', required: true, maxLength: 120 },
          category: { type: 'enum', required: true, values: ['Headphones', 'DAC/Amp'] },
          gtins: { type: 'gtin', list: true, identifier: true },
          mpns: { type: 'text', list: true, identifier: true, scope: 'brand', maxLength: 80 },
          officialUrl: { type: 'url' },
          specs: { type: 'specs', llm: true },
        },
      },
    },
    sources: [
      {
        id: 'maker-a',
        kind: 'pages',
        recordType: 'product',
        pages: ['https://maker-a.example/products/a1', 'https://maker-a.example/products/a2'],
        fixed: { brand: 'Maker A', category: 'Headphones' },
        extract: { officialUrl: { url: 'canonical' } },
        evidence: evidence('maker-a.example'),
      },
      {
        id: 'maker-b',
        kind: 'pages',
        recordType: 'product',
        pages: ['https://maker-b.example/products/b1'],
        fixed: { brand: 'Maker B', category: 'DAC/Amp' },
        extract: { name: { css: 'h1' }, officialUrl: { url: 'canonical' } },
        evidence: evidence('maker-b.example'),
      },
    ],
    policy: { purposes: ['ai-input'], perHostIntervalMs: 1000 },
    // Tests see every snapshot published; the gates' own tests choose theirs.
    publication: { approval: 'auto' },
    gates: { maxRemovals: { count: 25, share: 1 } },
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition;
}

/**
 * The test dataset with a third maker, whose pages its sitemaps list. Its category is fixed, as the
 * others' are, so its records are complete without the decision cascade.
 */
export function testSitemapDefinition(dataset = 'test-sitemaps'): Definition {
  const base = testDefinition(dataset);
  const result = parseDefinition({
    ...base,
    sources: [
      ...base.sources,
      {
        id: 'maker-c',
        kind: 'sitemap',
        recordType: 'product',
        sitemaps: ['https://maker-c.example/sitemap.xml'],
        follow: ['/sitemap_products_*'],
        include: ['/products/*'],
        exclude: ['/products/*-gift-card'],
        useLastmod: true,
        fixed: { brand: 'Maker C', category: 'Headphones' },
        extract: { officialUrl: { url: 'canonical' } },
        evidence: evidence('maker-c.example'),
      },
    ],
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition;
}
