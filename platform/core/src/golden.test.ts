import { describe, expect, it } from 'vitest';
import { goldenSetSchema, scoreDataset, type GoldenSet, type ItemView } from './golden';
import type { Snapshot } from './snapshot';

const page = (slug: string) => `https://maker.example/products/${slug}`;

const GOLDEN: GoldenSet = goldenSetSchema.parse({
  dataset: 'audio',
  version: 1,
  checked: '2026-10-14',
  identifiers: ['gtins', 'mpns'],
  specs: 'specs',
  products: [
    {
      key: 'maker-hd-600',
      pages: [page('hd-600')],
      fields: {
        brand: 'Maker',
        name: 'HD 600',
        category: 'Headphones',
        gtins: ['04044155011734'],
        specs: [
          { label: 'Impedance', value: '300 Ω' },
          { label: 'Weight', value: '260 g' },
        ],
      },
      checkedAgainst: ['https://retailer.example/hd-600'],
    },
    {
      key: 'maker-hd-650',
      pages: [page('hd-650')],
      fields: { brand: 'Maker', name: 'HD 650', category: 'Headphones' },
      checkedAgainst: ['https://retailer.example/hd-650'],
    },
    {
      key: 'maker-hd-660s',
      pages: [page('hd-660s')],
      fields: { brand: 'Maker', name: 'HD 660S', category: 'Headphones' },
      checkedAgainst: ['https://retailer.example/hd-660s'],
    },
    {
      key: 'maker-hd-800',
      pages: [page('hd-800')],
      fields: { brand: 'Maker', name: 'HD 800' },
      checkedAgainst: ['https://retailer.example/hd-800'],
    },
  ],
});

const record = (canonicalId: string, fields: Record<string, unknown>) => ({
  canonicalId,
  fields,
  provenance: {},
});

const SNAPSHOT: Snapshot = {
  project: 'audio',
  snapshotId: 'sn_eval',
  generation: 7,
  publishedAt: '2026-10-14T00:00:00.000Z',
  records: [
    record('sp_600', {
      brand: 'Maker',
      name: 'HD-600',
      category: 'Headphones',
      gtins: ['04044155011734'],
      specs: [
        { label: 'Nominal impedance', value: '300 Ω' },
        { label: 'Weight', value: '250 g' },
      ],
    }),
    // HD 650 and HD 660S were merged into one record, which names neither right.
    record('sp_mixed', { brand: 'Maker', name: 'HD 650', category: 'Headphones' }),
  ],
};

const ITEMS: ItemView[] = [
  { locator: page('hd-600'), sourceId: 'maker', status: 'live', entityId: 'sp_600' },
  { locator: page('hd-650'), sourceId: 'maker', status: 'live', entityId: 'sp_mixed' },
  { locator: page('hd-660s'), sourceId: 'maker', status: 'live', entityId: 'sp_mixed' },
  // HD 800's page was never read into a record.
  { locator: page('hd-800'), sourceId: 'maker', status: 'live', entityId: null },
];

/** The golden set's first product alone, with only these fields. */
const goldenWith = (fields: Record<string, unknown>): GoldenSet =>
  goldenSetSchema.parse({ ...GOLDEN, products: [{ ...GOLDEN.products[0]!, fields }] });

/** A snapshot of one record, sp_600, which the first golden product's page joined. */
const snapshotWith = (fields: Record<string, unknown>): Snapshot => ({
  ...SNAPSHOT,
  records: [record('sp_600', fields)],
});

/** What scoring says of the first golden product alone, with only these fields, against a record. */
const scoreOne = (golden: Record<string, unknown>, stated: Record<string, unknown>) =>
  scoreDataset({ golden: goldenWith(golden), snapshot: snapshotWith(stated), items: ITEMS });

/** A golden product that needs no checking against anything: it is found or missed by its pages. */
const productOf = (key: string, pages: string[]) => ({
  key,
  pages,
  fields: { name: key },
  checkedAgainst: ['https://retailer.example/x'],
});

describe('scoreDataset', () => {
  it('scores precision, recall, and each field, and lists what missed', () => {
    const scores = scoreDataset({ golden: GOLDEN, snapshot: SNAPSHOT, items: ITEMS });
    expect(scores).toMatchObject({
      generation: 7,
      products: 4,
      found: 3,
      recall: 0.75,
      precision: 0.5,
      split: 0,
      identifiers: { checked: 1, correct: 1, accuracy: 1 },
      keySpecs: { checked: 2, correct: 1, accuracy: 0.5 },
      targets: { precision: false, recall: false, identifiers: true, keySpecs: false },
    });
    expect(scores.fields.name).toEqual({ checked: 3, correct: 2, missing: 0, accuracy: 2 / 3 });
    expect(scores.misses).toEqual([
      'maker-hd-600: specs Weight is 250 g, not 260 g',
      'maker-hd-660s: name is HD 650, not HD 660S',
      'maker-hd-800: no published record',
      'sp_mixed mixes maker-hd-650, maker-hd-660s',
    ]);
  });

  it('refuses a golden set with a product listed twice', () => {
    const twice = {
      ...GOLDEN,
      products: [GOLDEN.products[0], GOLDEN.products[0]],
    };
    expect(goldenSetSchema.safeParse(twice).success).toBe(false);
  });

  it('compares GTINs as GS1 does, and part numbers by their key, however the golden set writes them', () => {
    const golden = goldenSetSchema.parse({
      ...GOLDEN,
      products: [
        { ...GOLDEN.products[0]!, fields: { gtins: ['819343015004'], mpns: ['483.664'] } },
      ],
    });
    const snapshot = {
      ...SNAPSHOT,
      records: [record('sp_600', { gtins: ['00819343015004'], mpns: ['483664'] })],
    };
    expect(scoreDataset({ golden, snapshot, items: ITEMS }).identifiers).toEqual({
      checked: 2,
      correct: 2,
      missing: 0,
      accuracy: 1,
    });
  });

  it('counts the values a record states, and reports the ones it leaves out apart', () => {
    // The record states the GTIN, and says nothing of the part number or the impedance.
    const scores = scoreOne(
      {
        gtins: ['04044155011734'],
        mpns: ['483.664'],
        specs: [{ label: 'Impedance', value: '300 Ω' }],
      },
      { gtins: ['04044155011734'] },
    );
    expect(scores.identifiers).toEqual({ checked: 1, correct: 1, missing: 1, accuracy: 1 });
    expect(scores.keySpecs).toEqual({ checked: 0, correct: 0, missing: 1, accuracy: 1 });
    expect(scores.fields.mpns).toEqual({ checked: 0, correct: 0, missing: 1, accuracy: 1 });
    // Accuracy counts only what the records state, so nothing stated is not a pass.
    expect(scores.targets).toMatchObject({ identifiers: true, keySpecs: false });
    // What was left out is still a miss to look at.
    expect(scores.misses).toEqual([
      'maker-hd-600: mpns is missing, not 483.664',
      'maker-hd-600: specs Impedance is missing, not 300 Ω',
    ]);
  });

  it('does not meet the identifiers target when none of the golden identifiers is stated', () => {
    const scores = scoreOne({ gtins: ['04044155011734'], mpns: ['483.664'] }, { name: 'HD 600' });
    expect(scores.identifiers).toEqual({ checked: 0, correct: 0, missing: 2, accuracy: 1 });
    expect(scores.targets.identifiers).toBe(false);
  });

  it('takes a list as right when every value the record states is a golden one', () => {
    const identifiersOf = (mpns: string[]) =>
      scoreOne({ mpns: ['A-1', 'B-2'] }, { mpns }).identifiers;
    // One of the two golden part numbers, written another way: right, and nothing is left out.
    expect(identifiersOf(['a1'])).toEqual({ checked: 1, correct: 1, missing: 0, accuracy: 1 });
    expect(identifiersOf(['b2', 'a1'])).toMatchObject({ checked: 1, correct: 1 });
    // A value the golden list lacks is wrong, beside the right ones.
    expect(identifiersOf(['a1', 'c3'])).toMatchObject({ checked: 1, correct: 0, accuracy: 0 });
    expect(identifiersOf(['c3'])).toMatchObject({ checked: 1, correct: 0, accuracy: 0 });
  });

  it('counts nothing for a golden list with no strings in it', () => {
    const golden = {
      gtins: [],
      mpns: [{ label: 'Part', value: 'A-1' }],
      specs: [],
    };
    // It counts nothing whether or not the record states the field.
    for (const stated of [{ gtins: ['04044155011734'], mpns: ['A-1'] }, {}]) {
      const scores = scoreOne(golden, stated);
      expect(scores.identifiers).toEqual({ checked: 0, correct: 0, missing: 0, accuracy: 1 });
      expect(scores.keySpecs).toEqual({ checked: 0, correct: 0, missing: 0, accuracy: 1 });
      expect(scores.fields).toEqual({});
      expect(scores.misses).toEqual([]);
      // With nothing to check, nothing is missed.
      expect(scores.targets).toMatchObject({ identifiers: true, keySpecs: true });
    }
  });

  it('takes the record’s spec whose label fits and whose value is the golden one', () => {
    const golden = { specs: [{ label: 'Weight', value: '612 g' }] };
    // "Shipping weight" fits "Weight" too, and comes first.
    const shipping = { label: 'Shipping weight', value: '2 kg' };
    const right = scoreOne(golden, { specs: [shipping, { label: 'Weight', value: '612g' }] });
    expect(right.keySpecs).toEqual({ checked: 1, correct: 1, missing: 0, accuracy: 1 });
    expect(right.misses).toEqual([]);
    // With no value right, the first that fits is the one named.
    const wrong = scoreOne(golden, { specs: [shipping, { label: 'Weight', value: '700 g' }] });
    expect(wrong.keySpecs).toEqual({ checked: 1, correct: 0, missing: 0, accuracy: 0 });
    expect(wrong.misses).toEqual(['maker-hd-600: specs Weight is 2 kg, not 612 g']);
  });

  it.each([['300 ohms'], [['300 ohms']]])(
    'counts no key specs for a golden specs field that is %j, not a list of specs',
    (specs) => {
      const scores = scoreOne({ specs }, { specs: [{ label: 'Impedance', value: '300 Ω' }] });
      expect(scores.keySpecs).toEqual({ checked: 0, correct: 0, missing: 0, accuracy: 1 });
      expect(scores.misses).toEqual([]);
    },
  );

  it('finds a product’s record by its page, however either address is written', () => {
    // Both are https://maker.example/products/hd-600 once the host's case, the default port, and
    // the dot segments are read as a browser reads them.
    const golden = goldenSetSchema.parse({
      ...GOLDEN,
      products: [productOf('maker-hd-600', ['https://MAKER.example:443/products/hd-600'])],
    });
    const items: ItemView[] = [
      {
        locator: 'https://maker.example/products/other/../hd-600',
        sourceId: 'maker',
        status: 'live',
        entityId: 'sp_600',
      },
    ];
    const scores = scoreDataset({ golden, snapshot: SNAPSHOT, items });
    expect(scores).toMatchObject({ found: 1, recall: 1, precision: 1 });
  });

  it('tells a page nobody lists apart from a page with no published record', () => {
    const golden = goldenSetSchema.parse({
      ...GOLDEN,
      products: [
        productOf('maker-listed', [page('listed')]),
        productOf('maker-unlisted', [page('unlisted')]),
        productOf('maker-two-unlisted', [page('one'), page('two')]),
        productOf('maker-gone', [page('gone')]),
        productOf('maker-left-out', [page('left-out')]),
      ],
    });
    const items: ItemView[] = [
      // However its address is written, it is an item.
      {
        locator: 'https://MAKER.example:443/products/listed',
        sourceId: 'maker',
        status: 'live',
        entityId: null,
      },
      // A page that is no longer live has no published record, even where it joined one.
      { locator: page('gone'), sourceId: 'maker', status: 'gone', entityId: 'sp_600' },
      // So does a live page whose record the snapshot left out.
      { locator: page('left-out'), sourceId: 'maker', status: 'live', entityId: 'sp_left_out' },
    ];
    const scores = scoreDataset({ golden, snapshot: SNAPSHOT, items });
    expect(scores).toMatchObject({ found: 0, recall: 0, precision: 0 });
    expect(scores.misses).toEqual([
      'maker-listed: no published record',
      'maker-unlisted: no item for its page',
      'maker-two-unlisted: no item for any of its pages',
      'maker-gone: no published record',
      'maker-left-out: no published record',
    ]);
  });

  it('meets a target by reaching it exactly', () => {
    const goldenOf = (count: number, fields: (index: number) => Record<string, unknown>) =>
      goldenSetSchema.parse({
        ...GOLDEN,
        products: Array.from({ length: count }, (_, index) => ({
          ...productOf(`maker-p-${index}`, [page(`p-${index}`)]),
          fields: fields(index),
        })),
      });
    /** Product `index`'s page joins the record this names, or none. */
    const itemsOf = (count: number, recordOf: (index: number) => string | null): ItemView[] =>
      Array.from({ length: count }, (_, index) => ({
        locator: page(`p-${index}`),
        sourceId: 'maker',
        status: 'live',
        entityId: recordOf(index),
      }));
    const snapshotOf = (records: [string, Record<string, unknown>][]): Snapshot => ({
      ...SNAPSHOT,
      records: records.map(([id, fields]) => record(id, fields)),
    });

    // Nine of ten products found is a recall of 0.9.
    const recalled = scoreDataset({
      golden: goldenOf(10, (index) => ({ name: `P ${index}` })),
      snapshot: snapshotOf(Array.from({ length: 9 }, (_, index) => [`sp_${index}`, {}])),
      items: itemsOf(10, (index) => (index < 9 ? `sp_${index}` : null)),
    });
    expect(recalled.recall).toBe(0.9);
    expect(recalled.targets.recall).toBe(true);

    // Forty-nine of fifty identifiers right is an accuracy of 0.98.
    const identified = scoreDataset({
      golden: goldenOf(50, (index) => ({ mpns: [`A-${index}`] })),
      snapshot: snapshotOf(
        Array.from({ length: 50 }, (_, index) => [
          `sp_${index}`,
          { mpns: [index === 0 ? 'B-0' : `A-${index}`] },
        ]),
      ),
      items: itemsOf(50, (index) => `sp_${index}`),
    });
    expect(identified.identifiers).toMatchObject({ checked: 50, correct: 49, accuracy: 0.98 });
    expect(identified.targets.identifiers).toBe(true);

    // Forty-nine of fifty key specs right is an accuracy of 0.98 too.
    const weight = (grams: number) => [{ label: 'Weight', value: `${grams} g` }];
    const specified = scoreDataset({
      golden: goldenOf(50, (index) => ({ specs: weight(index) })),
      snapshot: snapshotOf(
        Array.from({ length: 50 }, (_, index) => [
          `sp_${index}`,
          { specs: weight(index === 0 ? 999 : index) },
        ]),
      ),
      items: itemsOf(50, (index) => `sp_${index}`),
    });
    expect(specified.keySpecs).toMatchObject({ checked: 50, correct: 49, accuracy: 0.98 });
    expect(specified.targets.keySpecs).toBe(true);

    // Ninety-nine pure records of a hundred is a precision of 0.99: the last two products share one.
    const precise = scoreDataset({
      golden: goldenOf(101, () => ({ name: 'x' })),
      snapshot: snapshotOf([
        ...Array.from({ length: 99 }, (_, index): [string, Record<string, unknown>] => [
          `sp_${index}`,
          {},
        ]),
        ['sp_shared', {}],
      ]),
      items: itemsOf(101, (index) => (index < 99 ? `sp_${index}` : 'sp_shared')),
    });
    expect(precise.precision).toBe(0.99);
    expect(precise.targets.precision).toBe(true);
  });

  it('lists the first 200 misses, and says how many more there were', () => {
    const missesOf = (products: number) =>
      scoreDataset({
        golden: goldenSetSchema.parse({
          ...GOLDEN,
          products: Array.from({ length: products }, (_, index) =>
            productOf(`maker-p-${index}`, [page(`p-${index}`)]),
          ),
        }),
        snapshot: SNAPSHOT,
        items: [],
      }).misses;
    const cut = missesOf(250);
    expect(cut).toHaveLength(201);
    expect(cut[0]).toBe('maker-p-0: no item for its page');
    expect(cut[199]).toBe('maker-p-199: no item for its page');
    expect(cut[200]).toBe('…and 50 more');
    // Exactly 200 is all of them, and one more is one more.
    expect(missesOf(200)).toHaveLength(200);
    expect(missesOf(200).at(-1)).toBe('maker-p-199: no item for its page');
    expect(missesOf(201).at(-1)).toBe('…and 1 more');
  });

  it('counts a product spread over several records once, and scores its first', () => {
    const golden = goldenSetSchema.parse({
      ...GOLDEN,
      products: [
        {
          ...productOf('maker-hd-600', [page('hd-600'), page('hd-600-new')]),
          fields: { name: 'HD 600' },
        },
      ],
    });
    const snapshot = {
      ...SNAPSHOT,
      records: [record('sp_a', { name: 'HD 600' }), record('sp_b', { name: 'Other' })],
    };
    const items: ItemView[] = [
      { locator: page('hd-600'), sourceId: 'maker', status: 'live', entityId: 'sp_b' },
      { locator: page('hd-600-new'), sourceId: 'maker', status: 'live', entityId: 'sp_a' },
    ];
    const scores = scoreDataset({ golden, snapshot, items });
    expect(scores).toMatchObject({ found: 1, split: 1, recall: 1, precision: 1 });
    // The records in ID order: sp_a is the first, and says the name right.
    expect(scores.fields.name).toEqual({ checked: 1, correct: 1, missing: 0, accuracy: 1 });
    expect(scores.misses).toEqual(['maker-hd-600: spread over 2 records']);
  });
});

describe('goldenSetSchema', () => {
  it.each([
    [
      'a page that is not https',
      { products: [{ ...GOLDEN.products[0], pages: ['http://a.example/x'] }] },
    ],
    ['a key it does not know', { notes: 'checked on a Sunday' }],
    ['no products', { products: [] }],
    ['a date that is not one', { checked: '14 October' }],
    ['a product key in capitals', { products: [{ ...GOLDEN.products[0], key: 'Maker-HD-600' }] }],
    ['a version below 1', { version: 0 }],
  ])('refuses %s', (_name, change) => {
    expect(goldenSetSchema.safeParse({ ...GOLDEN, ...change }).success).toBe(false);
  });

  it('takes a golden set as it is written', () => {
    expect(goldenSetSchema.safeParse(GOLDEN).success).toBe(true);
  });
});
