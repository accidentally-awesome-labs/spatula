import { parseDefinition } from '../definition';
import { buildRecords, type Snapshot } from '../snapshot';
import type { StatementView } from '../survivorship';
import { applyChanges } from '../taxonomy-changes';
import {
  findItem,
  seedTaxonomy,
  taxonomySeedSchema,
  type TaxonomySeed,
  type TaxonomySubject,
} from '../taxonomy';

/*
 * A small taxonomy for core's tests: three categories, two with subcategories, four functions, and
 * two features, one of each cardinality. The store's fixtures have the same one for the other
 * packages' tests.
 */

/** IDs in order, each valid: tx_ and 20 digits. */
export function countingIds(): () => string {
  let n = 0;
  return () => `tx_${String((n += 1)).padStart(20, '0')}`;
}

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

/** The example snapshot's pages, which its records' provenance names. */
const BERTTI = 'https://chordelectronics.co.uk/product/bertti';
const LCD_X = 'https://www.audeze.com/products/lcd-x';
const QUTEST = 'https://chordelectronics.co.uk/product/qutest';
/** When the example's statements were last seen. */
const SEEN = '2026-11-02T06:00:00.000Z';

/**
 * The snapshot contract's example (ADR 0007): generation 3 of Crowdio's dataset, with this
 * taxonomy at version 2, after preamps merged into power amps, and three records built from
 * statements as publishing builds them. BerTTi is on Power amps, built for speakers, as a person
 * placed it. LCD-X is on Over-ear, with open cups, as the decider placed it. Qutest is on DACs, by
 * its source's rule. `serializeSnapshot` of it is the canonical example-taxonomy-snapshot.json,
 * which Crowdio keeps a copy of.
 */
export function exampleTaxonomySnapshot(): Snapshot {
  const seeded = seedTaxonomy(testTaxonomySeed(), countingIds());
  if (!seeded.ok) throw new Error(seeded.issues.join('\n'));
  const merged = applyChanges(
    seeded.taxonomy,
    [{ kind: 'merge', subject: 'shelf', from: 'preamps', into: 'power-amps' }],
    () => {
      throw new Error('A merge makes no ID.');
    },
  );
  if (!merged.ok) throw new Error(merged.issues.join('\n'));
  const taxonomy = merged.taxonomy;
  const parsed = parseDefinition({
    dataset: 'crowdio-audio-products',
    scope: taxonomy.scope,
    recordTypes: {
      product: {
        identity: { identifiers: ['gtins'], keys: [['brand', 'name']] },
        taxonomy: { decide: true },
        fields: {
          brand: { type: 'text', required: true, maxLength: 80 },
          name: { type: 'text', required: true, maxLength: 120 },
          gtins: { type: 'gtin', list: true, identifier: true },
          officialUrl: { type: 'url' },
        },
      },
    },
    sources: [
      {
        id: 'chord',
        kind: 'pages',
        recordType: 'product',
        pages: [BERTTI, QUTEST],
        fixed: { brand: 'Chord Electronics' },
        extract: { officialUrl: { url: 'canonical' } },
        evidence: {
          robots: '2026-10-09',
          terms: {
            url: 'https://chordelectronics.co.uk/terms-and-conditions',
            checked: '2026-10-09',
            automatedAccess: 'not-mentioned',
          },
        },
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  const id = (subject: TaxonomySubject, slug: string) => findItem(taxonomy, subject, slug)!.id;
  const on =
    (sourceUrl: string) =>
    (
      property: string,
      value: string,
      method: StatementView['method'],
      confidence = 1,
    ): StatementView => ({
      property,
      value,
      valueKey: value,
      method,
      confidence,
      lastSeen: SEEN,
      sourceUrl,
      position: null,
    });
  const bertti = on(BERTTI);
  const lcdX = on(LCD_X);
  const qutest = on(QUTEST);
  const { records, excluded } = buildRecords(
    parsed.definition.recordTypes.product!,
    [
      {
        canonicalId: 'sp_00000000000000000001',
        statements: [
          bertti('brand', 'Chord Electronics', 'rule'),
          bertti('name', 'BerTTi', 'jsonld', 0.9),
          bertti('officialUrl', BERTTI, 'rule'),
          bertti('shelf', id('shelf', 'power-amps'), 'human'),
          bertti('features', id('value', 'speakers'), 'human'),
        ],
      },
      {
        canonicalId: 'sp_00000000000000000002',
        statements: [
          lcdX('brand', 'Audeze', 'jsonld', 0.9),
          lcdX('name', 'LCD-X', 'jsonld', 0.9),
          lcdX('officialUrl', LCD_X, 'rule'),
          lcdX('shelf', id('shelf', 'over-ear'), 'llm', 0.96),
          lcdX('features', id('value', 'open'), 'llm', 0.95),
        ],
      },
      {
        canonicalId: 'sp_00000000000000000003',
        statements: [
          qutest('brand', 'Chord Electronics', 'rule'),
          qutest('name', 'Qutest', 'jsonld', 0.9),
          qutest('officialUrl', QUTEST, 'rule'),
          qutest('shelf', id('shelf', 'dacs'), 'rule'),
        ],
      },
    ],
    taxonomy,
  );
  if (excluded.length > 0) {
    throw new Error(`The example leaves records out: ${JSON.stringify(excluded)}`);
  }
  return {
    project: 'crowdio-audio-products',
    snapshotId: 'sn_00000000000000000003',
    generation: 3,
    publishedAt: '2026-11-02T09:14:00.000Z',
    taxonomy,
    records,
  };
}
