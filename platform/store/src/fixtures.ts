import {
  parseDefinition,
  seedTaxonomy,
  taxonomySeedSchema,
  type Definition,
  type Taxonomy,
  type TaxonomySeed,
} from '@spatula/core';

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

/** The same small taxonomy core's tests use: three categories, four functions, two features. */
export function testTaxonomySeed(): TaxonomySeed {
  return taxonomySeedSchema.parse({
    scope:
      'Hi-fi made for audio: headphones, DACs, and amplifiers. Out of scope: accessories (cables, stands).',
    functions: [
      { slug: 'dac', name: 'DAC', description: 'Converts digital audio to analog' },
      {
        slug: 'pre-amp',
        name: 'Pre-amp',
        description: 'Selects inputs and sets volume at line level',
      },
      {
        slug: 'amplifier',
        name: 'Amplifier',
        description: 'Drives headphones, IEMs, or speakers',
      },
      {
        slug: 'headphones',
        name: 'Headphones',
        description: 'Turns a signal into sound on the ears',
      },
    ],
    shelves: [
      {
        slug: 'headphones',
        name: 'Headphones',
        description: 'Worn over or on the ears with a headband',
        implies: ['headphones'],
        children: [
          {
            slug: 'over-ear',
            name: 'Over-ear',
            description: 'Cups around the ears',
            implies: ['headphones'],
          },
          {
            slug: 'on-ear',
            name: 'On-ear',
            description: 'Pads on the ears',
            implies: ['headphones'],
          },
        ],
      },
      {
        slug: 'dacs',
        name: 'DACs',
        description: 'Convert digital audio to analog',
        implies: ['dac'],
      },
      {
        slug: 'amplifiers',
        name: 'Amplifiers',
        description: 'Set a signal’s level or drive headphones or speakers',
        children: [
          {
            slug: 'headphone-amps',
            name: 'Headphone amps',
            description: 'Drive headphones',
            implies: ['amplifier'],
          },
          {
            slug: 'preamps',
            name: 'Preamps',
            description: 'Set volume at line level',
            implies: ['pre-amp'],
          },
          {
            slug: 'power-amps',
            name: 'Power amps',
            description: 'Drive speakers',
            implies: ['amplifier'],
          },
        ],
      },
    ],
    features: [
      {
        slug: 'back',
        name: 'Back',
        description: 'Whether the cups let sound through',
        cardinality: 'one',
        shelves: ['headphones'],
        values: [
          { slug: 'open', name: 'Open', description: 'Cups that let sound through' },
          { slug: 'closed', name: 'Closed', description: 'Sealed cups' },
        ],
      },
      {
        slug: 'drives',
        name: 'Drives',
        description: 'What its amplifier is built for',
        cardinality: 'many',
        shelves: ['amplifiers'],
        values: [
          { slug: 'iems', name: 'IEMs', description: 'In-ear monitors' },
          { slug: 'headphones', name: 'Headphones', description: 'Headphones' },
          { slug: 'speakers', name: 'Speakers', description: 'Loudspeakers' },
        ],
      },
    ],
  });
}

/** The test taxonomy as version 1, with IDs tx_00000000000000000001 onwards, in seed order. */
export function testTaxonomy(): Taxonomy {
  let n = 0;
  const seeded = seedTaxonomy(testTaxonomySeed(), () => `tx_${String((n += 1)).padStart(20, '0')}`);
  if (!seeded.ok) throw new Error(seeded.issues.join('\n'));
  return seeded.taxonomy;
}

/**
 * The test dataset with a taxonomy in place of its category enum: its scope is the test taxonomy's,
 * and no source fixes a category.
 */
export function testTaxonomyDefinition(dataset = 'test-taxonomy'): Definition {
  const base = testDefinition(dataset);
  const product = base.recordTypes.product!;
  const fields = Object.fromEntries(
    Object.entries(product.fields).filter(([name]) => name !== 'category'),
  );
  const result = parseDefinition({
    ...base,
    scope: testTaxonomySeed().scope,
    recordTypes: { product: { ...product, fields, taxonomy: { decide: true } } },
    sources: base.sources.map((source) => ({ ...source, fixed: { brand: source.fixed.brand } })),
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition;
}
