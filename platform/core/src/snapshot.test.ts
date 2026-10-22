import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import { basePages, type EntityMember } from './editions';
import { stableStringify } from './ids';
import { buildRecords, serializeSnapshot, snapshotSchema } from './snapshot';
import type { StatementView } from './survivorship';
import { countingIds, exampleTaxonomySnapshot, testTaxonomySeed } from './testing/taxonomy';
import { findItem, seedTaxonomy, type Taxonomy, type TaxonomySubject } from './taxonomy';

const parsed = parseDefinition({
  dataset: 'audio-products',
  recordTypes: {
    product: {
      identity: { identifiers: ['gtins'], keys: [['brand', 'name']] },
      fields: {
        brand: { type: 'text', required: true },
        name: { type: 'text', required: true },
        category: { type: 'enum', required: true, values: ['Headphones'] },
        gtins: { type: 'gtin', list: true, identifier: true },
        officialUrl: { type: 'url' },
      },
    },
  },
  sources: [
    {
      id: 'maker',
      kind: 'pages',
      recordType: 'product',
      pages: ['https://maker.example/a'],
      evidence: {
        robots: '2026-10-09',
        terms: {
          url: 'https://maker.example/terms',
          checked: '2026-10-09',
          automatedAccess: 'allowed',
        },
      },
    },
  ],
});
if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
const product = parsed.definition.recordTypes.product as RecordType;

const SEEN = '2026-10-10T00:00:00.000Z';
const view = (
  property: string,
  value: string,
  method: StatementView['method'] = 'rule',
): StatementView => ({
  property,
  value,
  valueKey: value,
  method,
  confidence: method === 'rule' ? 1 : 0.9,
  lastSeen: SEEN,
  sourceUrl: 'https://www.audeze.com/products/lcd-x',
  position: property === 'gtins' ? 0 : null,
});

const LATER = '2026-10-12T00:00:00.000Z';

/** A page's statements, each seen at `lastSeen`, as structured data says them unless told. */
const said = (
  url: string,
  lastSeen: string,
  values: Record<string, string>,
  method: StatementView['method'] = 'jsonld',
): StatementView[] =>
  Object.entries(values).map(([property, value]) => ({
    property,
    value,
    valueKey: value,
    method,
    confidence: 0.9,
    lastSeen,
    sourceUrl: url,
    position: property === 'gtins' ? 0 : null,
  }));

const page = (
  url: string,
  firstSeen: string,
  edition: boolean,
  statements: StatementView[],
): EntityMember => ({ url, firstSeen, edition, statements });

/** A test taxonomy ID by its place in the seed: tx_ and 20 digits. */
const tx = (n: number) => `tx_${String(n).padStart(20, '0')}`;

describe('buildRecords', () => {
  it('writes records in the published format, in canonical-ID order, and leaves out incomplete ones', () => {
    const { records, excluded } = buildRecords(product, [
      {
        canonicalId: 'sp_b',
        statements: [view('brand', 'Audeze'), view('category', 'Headphones')],
      },
      {
        canonicalId: 'sp_a',
        statements: [
          view('brand', 'Audeze'),
          view('name', 'LCD-X', 'jsonld'),
          view('category', 'Headphones'),
          view('gtins', '00819343015004', 'jsonld'),
          view('officialUrl', 'https://www.audeze.com/products/lcd-x'),
        ],
      },
    ]);
    expect(excluded).toEqual([{ canonicalId: 'sp_b', missing: ['name'] }]);
    expect(records).toEqual([
      {
        canonicalId: 'sp_a',
        fields: {
          brand: 'Audeze',
          name: 'LCD-X',
          category: 'Headphones',
          gtins: ['00819343015004'],
          officialUrl: 'https://www.audeze.com/products/lcd-x',
        },
        provenance: {
          brand: {
            sourceUrl: 'https://www.audeze.com/products/lcd-x',
            fetchedAt: SEEN,
            method: 'rule',
            confidence: 1,
          },
          name: {
            sourceUrl: 'https://www.audeze.com/products/lcd-x',
            fetchedAt: SEEN,
            method: 'jsonld',
            confidence: 0.9,
          },
          category: {
            sourceUrl: 'https://www.audeze.com/products/lcd-x',
            fetchedAt: SEEN,
            method: 'rule',
            confidence: 1,
          },
          gtins: {
            sourceUrl: 'https://www.audeze.com/products/lcd-x',
            fetchedAt: SEEN,
            method: 'jsonld',
            confidence: 0.9,
          },
          officialUrl: {
            sourceUrl: 'https://www.audeze.com/products/lcd-x',
            fetchedAt: SEEN,
            method: 'rule',
            confidence: 1,
          },
        },
      },
    ]);
  });
});

describe('buildRecords with the record’s pages', () => {
  const CLUB = 'https://maker.example/p/dj-300-pro-x-club';
  const BASE = 'https://maker.example/p/dj-300-pro-x';
  const recordOf = (members: EntityMember[]) =>
    buildRecords(product, [
      {
        canonicalId: 'sp_dj',
        statements: members.flatMap((member) => member.statements),
        members,
      },
    ]).records[0]!;

  it('takes the name and single values from the base page, though its edition was met first and read last', () => {
    // The Club's page started the record, so the base page is the one that joined as an edition.
    const club = page(
      CLUB,
      '2026-10-01T00:00:00.000Z',
      false,
      said(CLUB, LATER, {
        brand: 'beyerdynamic',
        name: 'DJ 300 PRO X Club',
        category: 'Headphones',
        gtins: '04010118471063',
        officialUrl: CLUB,
      }),
    );
    const base = page(
      BASE,
      '2026-10-05T00:00:00.000Z',
      true,
      said(BASE, SEEN, {
        brand: 'beyerdynamic',
        name: 'DJ 300 PRO X',
        category: 'Headphones',
        gtins: '04010118471070',
        officialUrl: BASE,
      }),
    );
    const record = recordOf([club, base]);
    expect(record.fields).toEqual({
      brand: 'beyerdynamic',
      name: 'DJ 300 PRO X',
      category: 'Headphones',
      gtins: ['04010118471063', '04010118471070'],
      officialUrl: BASE,
    });
    expect(record.provenance.name).toMatchObject({ sourceUrl: BASE });
    expect(record.editions).toEqual([
      { name: 'DJ 300 PRO X Club', officialUrl: CLUB, gtins: ['04010118471063'] },
    ]);
  });

  it('fills a field only an edition states, and lets a person’s word count wherever it was said', () => {
    const base = page(
      BASE,
      '2026-10-01T00:00:00.000Z',
      false,
      said(
        BASE,
        SEEN,
        { brand: 'beyerdynamic', name: 'DJ 300 PRO X', category: 'Speakers' },
        'llm',
      ),
    );
    const club = page(CLUB, '2026-10-05T00:00:00.000Z', true, [
      ...said(CLUB, LATER, {
        name: 'DJ 300 PRO X Club',
        gtins: '04010118471063',
        officialUrl: CLUB,
      }),
      ...said(CLUB, LATER, { category: 'Headphones' }, 'human'),
    ]);
    expect(recordOf([base, club]).fields).toEqual({
      brand: 'beyerdynamic',
      name: 'DJ 300 PRO X',
      category: 'Headphones',
      gtins: ['04010118471063'],
      officialUrl: CLUB,
    });
  });

  it('takes the earliest page that didn’t join as an edition when no name extends another', () => {
    const echo = (letter: string, firstSeen: string, edition: boolean) => {
      const url = `https://maker.example/p/echo-${letter.toLowerCase()}`;
      return page(
        url,
        firstSeen,
        edition,
        said(url, SEEN, { brand: 'Moondrop', name: `Echo ${letter}`, category: 'Headphones' }),
      );
    };
    const record = recordOf([
      echo('A', '2026-10-03T00:00:00.000Z', false),
      echo('B', '2026-10-01T00:00:00.000Z', true),
      echo('C', '2026-10-02T00:00:00.000Z', false),
    ]);
    expect(record.fields.name).toBe('Echo C');
    expect(record.editions).toEqual([
      { name: 'Echo A', officialUrl: 'https://maker.example/p/echo-a', gtins: [] },
      { name: 'Echo B', officialUrl: 'https://maker.example/p/echo-b', gtins: [] },
    ]);
  });

  it('counts pages written as the base with it, and lists no editions when every name is alike', () => {
    const one = page(
      'https://maker.example/p/hd-650',
      '2026-10-01T00:00:00.000Z',
      false,
      said('https://maker.example/p/hd-650', SEEN, {
        brand: 'Sennheiser',
        name: 'HD 650',
        category: 'Headphones',
      }),
    );
    const two = page(
      'https://maker.example/p/hd650',
      '2026-10-02T00:00:00.000Z',
      false,
      said('https://maker.example/p/hd650', LATER, {
        brand: 'Sennheiser',
        name: 'HD-650',
        category: 'Headphones',
      }),
    );
    const record = recordOf([one, two]);
    // Both pages are the base, so survivorship chooses between them as before: the newer name.
    expect(record.fields.name).toBe('HD-650');
    expect('editions' in record).toBe(false);
  });

  it('builds a record without its pages as before, with no editions', () => {
    const { records } = buildRecords(product, [
      {
        canonicalId: 'sp_x',
        statements: said('https://maker.example/p/x', SEEN, {
          brand: 'Audeze',
          name: 'LCD-X',
          category: 'Headphones',
        }),
      },
    ]);
    expect(records[0]!.fields).toEqual({ brand: 'Audeze', name: 'LCD-X', category: 'Headphones' });
    expect('editions' in records[0]!).toBe(false);
  });
});

describe('basePages', () => {
  it('takes the page whose name every other page’s differing name extends', () => {
    const named = (name: string, edition = false) => {
      const url = `https://maker.example/p/${encodeURIComponent(name)}`;
      return page(url, SEEN, edition, said(url, SEEN, { name }));
    };
    const base = basePages(product, [
      named('Hugo Silver'),
      named('Hugo', true),
      named('Hugo Black'),
    ]);
    expect(base?.map((member) => member.url)).toEqual(['https://maker.example/p/Hugo']);
    expect(basePages(product, [])).toBeNull();
  });

  it('takes the same base whichever spelling of a name Spatula met first', () => {
    // "Moon River 2" and "MoonRiver2" are one name written two ways, in different words. The Ti
    // extends the name as one of them writes it.
    const named = (name: string, firstSeen: string, edition: boolean) => {
      const url = `https://maker.example/p/${encodeURIComponent(name)}`;
      return page(
        url,
        firstSeen,
        edition,
        said(url, SEEN, { brand: 'Moondrop', name, category: 'Headphones' }),
      );
    };
    const ti = named('MoonRiver 2 Ti', '2026-10-01T00:00:00.000Z', false);
    const orders = [
      [
        ti,
        named('Moon River 2', '2026-10-02T00:00:00.000Z', false),
        named('MoonRiver2', '2026-10-03T00:00:00.000Z', true),
      ],
      [
        ti,
        named('MoonRiver2', '2026-10-02T00:00:00.000Z', false),
        named('Moon River 2', '2026-10-03T00:00:00.000Z', true),
      ],
    ];
    for (const members of orders) {
      expect(
        basePages(product, members)
          ?.map((member) => member.url)
          .sort(),
      ).toEqual(['https://maker.example/p/Moon%20River%202', 'https://maker.example/p/MoonRiver2']);
      const [record] = buildRecords(product, [
        {
          canonicalId: 'sp_mr',
          statements: members.flatMap((member) => member.statements),
          members,
        },
      ]).records;
      expect(record!.fields.name).toBe('Moon River 2');
      expect(record!.editions).toEqual([
        { name: 'MoonRiver 2 Ti', officialUrl: ti.url, gtins: [] },
      ]);
    }
  });

  it('never takes a page without a name as the base while another page gives one', () => {
    const nameless = page(
      'https://maker.example/p/echo',
      '2026-10-01T00:00:00.000Z',
      false,
      said('https://maker.example/p/echo', SEEN, { brand: 'Moondrop', category: 'Headphones' }),
    );
    const echo = (letter: string, firstSeen: string, lastSeen: string) => {
      const url = `https://maker.example/p/echo-${letter.toLowerCase()}`;
      return page(url, firstSeen, true, said(url, lastSeen, { name: `Echo ${letter}` }));
    };
    // Echo B was read last, so survivorship across every page would name the record after it.
    const members = [
      nameless,
      echo('A', '2026-10-02T00:00:00.000Z', SEEN),
      echo('B', '2026-10-03T00:00:00.000Z', LATER),
    ];
    expect(basePages(product, members)?.map((member) => member.url)).toEqual([
      'https://maker.example/p/echo-a',
    ]);
    const [record] = buildRecords(product, [
      {
        canonicalId: 'sp_echo',
        statements: members.flatMap((member) => member.statements),
        members,
      },
    ]).records;
    expect(record!.fields).toEqual({ brand: 'Moondrop', name: 'Echo A', category: 'Headphones' });
    expect(record!.editions).toEqual([
      { name: 'Echo B', officialUrl: 'https://maker.example/p/echo-b', gtins: [] },
    ]);
  });
});

describe('snapshotSchema', () => {
  const snapshot = {
    project: 'crowdio-audio-products',
    snapshotId: 'sn_0123456789abcdefghjk',
    generation: 1,
    publishedAt: '2026-10-10T00:00:00.000Z',
    records: [
      {
        canonicalId: 'sp_a',
        fields: { brand: 'Audeze', name: 'LCD-X', category: 'Headphones' },
        provenance: {
          name: {
            sourceUrl: 'https://maker.example/a',
            fetchedAt: SEEN,
            method: 'jsonld',
            confidence: 0.9,
          },
        },
      },
    ],
  };

  it('accepts what Crowdio reads', () => {
    expect(snapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('refuses what Crowdio would refuse', () => {
    expect(snapshotSchema.safeParse({ ...snapshot, project: 'two\nlines' }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...snapshot, generation: 0 }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...snapshot, publishedAt: '2026-10-10 00:00' }).success).toBe(
      false,
    );
    const sure = { ...snapshot.records[0]!.provenance.name, confidence: 1.2 };
    expect(
      snapshotSchema.safeParse({
        ...snapshot,
        records: [{ ...snapshot.records[0], provenance: { name: sure } }],
      }).success,
    ).toBe(false);
  });

  it('refuses a record listed twice', () => {
    const result = snapshotSchema.safeParse({
      ...snapshot,
      records: [snapshot.records[0], snapshot.records[0]],
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map(({ code, message, path }) => ({ code, message, path })),
    ).toEqual([
      {
        code: 'custom',
        message: 'The snapshot has this record more than once.',
        path: ['records', 1, 'canonicalId'],
      },
    ]);
  });

  it('reads a snapshot from before the taxonomy', () => {
    // As every snapshot published before ADR 0007: a category, no taxonomy, and the file's bytes.
    const file = JSON.stringify(snapshot);
    const read = snapshotSchema.parse(JSON.parse(file));
    expect(read).not.toHaveProperty('taxonomy');
    expect(read.records[0]!.fields).toEqual({
      brand: 'Audeze',
      name: 'LCD-X',
      category: 'Headphones',
    });
    expect(serializeSnapshot(read)).toBe(file);
    // Without a taxonomy, a field called shelf is the record type's own, and nothing checks it.
    const shelved = {
      ...snapshot,
      records: [
        {
          ...snapshot.records[0]!,
          fields: { ...snapshot.records[0]!.fields, shelf: 'Top', functions: 'none' },
        },
      ],
    };
    expect(snapshotSchema.safeParse(shelved).success).toBe(true);
  });

  it('checks the taxonomy a snapshot carries, and each record’s place in it', () => {
    const example = exampleTaxonomySnapshot();
    const issuesOf = (value: unknown) =>
      snapshotSchema
        .safeParse(value)
        .error?.issues.map(({ path, message }) => ({ path, message })) ?? [];
    expect(issuesOf(example)).toEqual([]);
    // BerTTi on preamps, which version 2 merged away: a reader couldn't place it.
    const [bertti, ...rest] = example.records;
    const unplaced = { ...bertti!, fields: { ...bertti!.fields, shelf: tx(11) } };
    expect(issuesOf({ ...example, records: [unplaced, ...rest] })).toEqual([
      {
        path: ['records', 0, 'fields', 'shelf'],
        message: 'A record’s shelf is a live shelf of the snapshot’s taxonomy.',
      },
    ]);
    // A taxonomy that isn't one is refused for itself.
    const older = { ...example, taxonomy: { ...example.taxonomy!, version: 1 } };
    expect(issuesOf(older)).toContainEqual({
      path: ['taxonomy', 'migrations', 0, 'version'],
      message: 'A migration can’t be newer than its taxonomy.',
    });
  });

  it('reads a record’s editions, refuses an edition with keys it doesn’t know, and reads a record without them', () => {
    const edition = {
      name: 'DJ 300 PRO X Club',
      officialUrl: 'https://north-america.beyerdynamic.com/p/dj-300-pro-x-club',
      gtins: ['04010118471063'],
    };
    const withEditions = {
      ...snapshot,
      records: [{ ...snapshot.records[0]!, editions: [edition] }],
    };
    expect(snapshotSchema.parse(withEditions)).toEqual(withEditions);
    expect(
      snapshotSchema.safeParse({
        ...snapshot,
        records: [{ ...snapshot.records[0]!, editions: [{ ...edition, color: 'Silver' }] }],
      }).success,
    ).toBe(false);
    expect(snapshotSchema.parse(snapshot).records[0]).not.toHaveProperty('editions');
  });
});

describe('buildRecords with a taxonomy', () => {
  const seeded = seedTaxonomy(testTaxonomySeed(), countingIds());
  if (!seeded.ok) throw new Error(seeded.issues.join('\n'));
  const taxonomy = seeded.taxonomy;
  const id = (subject: TaxonomySubject, slug: string) => findItem(taxonomy, subject, slug)!.id;
  const placing = parseDefinition({
    dataset: 'audio-products',
    scope: taxonomy.scope,
    recordTypes: {
      product: {
        identity: { identifiers: ['gtins'], keys: [['brand', 'name']] },
        taxonomy: { decide: true },
        fields: {
          brand: { type: 'text', required: true },
          name: { type: 'text', required: true },
          gtins: { type: 'gtin', list: true, identifier: true },
          officialUrl: { type: 'url' },
        },
      },
    },
    sources: [
      {
        id: 'maker',
        kind: 'pages',
        recordType: 'product',
        pages: ['https://maker.example/a'],
        evidence: {
          robots: '2026-10-09',
          terms: {
            url: 'https://maker.example/terms',
            checked: '2026-10-09',
            automatedAccess: 'allowed',
          },
        },
      },
    ],
  });
  if (!placing.ok) throw new Error(placing.issues.join('\n'));
  const placed = placing.definition.recordTypes.product as RecordType;
  const lcdX = [view('brand', 'Audeze'), view('name', 'LCD-X', 'jsonld')];
  const at = (method: StatementView['method'], confidence: number) => ({
    sourceUrl: 'https://www.audeze.com/products/lcd-x',
    fetchedAt: SEEN,
    method,
    confidence,
  });

  it('places each record after its own fields, and leaves out one whose shelf is unknown', () => {
    const { records, excluded } = buildRecords(
      placed,
      [
        { canonicalId: 'sp_b', statements: lcdX },
        {
          canonicalId: 'sp_a',
          statements: [
            ...lcdX,
            view('shelf', id('shelf', 'over-ear'), 'llm'),
            view('features', id('value', 'open'), 'llm'),
          ],
        },
        { canonicalId: 'sp_c', statements: [view('shelf', id('shelf', 'dacs'))] },
      ],
      taxonomy,
    );
    expect(excluded).toEqual([
      { canonicalId: 'sp_b', missing: ['shelf'] },
      { canonicalId: 'sp_c', missing: ['brand', 'name'] },
    ]);
    expect(records).toEqual([
      {
        canonicalId: 'sp_a',
        fields: {
          brand: 'Audeze',
          name: 'LCD-X',
          shelf: id('shelf', 'over-ear'),
          functions: [id('function', 'headphones')],
          features: { [id('feature', 'back')]: [id('value', 'open')] },
          category: 'Headphones',
        },
        provenance: {
          brand: at('rule', 1),
          name: at('jsonld', 0.9),
          shelf: at('llm', 0.9),
          functions: at('llm', 0.9),
          features: at('llm', 0.9),
          category: at('llm', 0.9),
        },
      },
    ]);
    expect(Object.keys(records[0]!.fields)).toEqual([
      'brand',
      'name',
      'shelf',
      'functions',
      'features',
      'category',
    ]);
  });

  it('takes category from the shelf alone, though a category stated before the taxonomy is current', () => {
    // A page switched to the taxonomy keeps its category statements: nothing withdraws them.
    const { records } = buildRecords(
      placed,
      [
        {
          canonicalId: 'sp_a',
          statements: [
            ...lcdX,
            view('category', 'DACs', 'human'),
            view('shelf', id('shelf', 'over-ear'), 'llm'),
          ],
        },
      ],
      taxonomy,
    );
    expect(records[0]!.fields.category).toBe('Headphones');
    expect(records[0]!.provenance.category).toEqual(at('llm', 0.9));
  });

  it('places a record from its base page, with a person’s word from any page, else from every page', () => {
    const BASE = 'https://maker.example/p/lcd-x';
    const CARBON = 'https://maker.example/p/lcd-x-carbon';
    const recordOf = (base: StatementView[], carbon: StatementView[]) => {
      const members = [
        page(BASE, '2026-10-01T00:00:00.000Z', false, [
          ...said(BASE, SEEN, { brand: 'Audeze', name: 'LCD-X' }),
          ...base,
        ]),
        page(CARBON, '2026-10-02T00:00:00.000Z', true, [
          ...said(CARBON, LATER, { name: 'LCD-X Carbon' }),
          ...carbon,
        ]),
      ];
      const statements = members.flatMap((member) => member.statements);
      return buildRecords(placed, [{ canonicalId: 'sp_x', statements, members }], taxonomy)
        .records[0]!;
    };
    // The edition's page was read last, so across every page its shelf and back would win.
    const overEar = said(BASE, SEEN, { shelf: id('shelf', 'over-ear') }, 'llm');
    const open = said(BASE, SEEN, { features: id('value', 'open') }, 'llm');
    const onEar = said(CARBON, LATER, { shelf: id('shelf', 'on-ear') }, 'llm');
    const closed = said(CARBON, LATER, { features: id('value', 'closed') }, 'llm');
    const fromBase = recordOf([...overEar, ...open], [...onEar, ...closed]);
    expect(fromBase.fields).toMatchObject({
      name: 'LCD-X',
      shelf: id('shelf', 'over-ear'),
      features: { [id('feature', 'back')]: [id('value', 'open')] },
    });
    expect(fromBase.provenance.shelf).toMatchObject({ sourceUrl: BASE });
    expect(fromBase.editions).toEqual([{ name: 'LCD-X Carbon', officialUrl: CARBON, gtins: [] }]);
    // A person's word counts wherever it was said.
    const person = said(CARBON, LATER, { shelf: id('shelf', 'on-ear') }, 'human');
    expect(recordOf(overEar, person).fields.shelf).toBe(id('shelf', 'on-ear'));
    // A base page that names no shelf leaves the record to every page's statements.
    const pooled = recordOf([], [...onEar, ...closed]);
    expect(pooled.fields).toMatchObject({
      shelf: id('shelf', 'on-ear'),
      features: { [id('feature', 'back')]: [id('value', 'closed')] },
    });
    expect(pooled.provenance.shelf).toMatchObject({ sourceUrl: CARBON });
  });

  it('leaves every record out, missing its shelf, while the dataset has no taxonomy', () => {
    const statements = [...lcdX, view('shelf', id('shelf', 'over-ear'), 'llm')];
    expect(buildRecords(placed, [{ canonicalId: 'sp_a', statements }])).toEqual({
      records: [],
      excluded: [{ canonicalId: 'sp_a', missing: ['shelf'] }],
    });
  });

  it('builds a record type without a taxonomy as it always did, whatever taxonomy it’s given', () => {
    const entities = [
      {
        canonicalId: 'sp_a',
        statements: [
          ...lcdX,
          view('category', 'Headphones'),
          view('shelf', id('shelf', 'over-ear')),
        ],
      },
    ];
    expect(buildRecords(product, entities, taxonomy)).toEqual(buildRecords(product, entities));
    expect(buildRecords(product, entities).records[0]!.fields).toEqual({
      brand: 'Audeze',
      name: 'LCD-X',
      category: 'Headphones',
    });
  });
});

describe('serializeSnapshot', () => {
  it('writes compact JSON in the contract’s order, however the snapshot was read', () => {
    const example = exampleTaxonomySnapshot();
    const written = serializeSnapshot(example);
    expect(written).not.toContain('\n');
    expect(Object.keys(JSON.parse(written) as object)).toEqual([
      'project',
      'snapshotId',
      'generation',
      'publishedAt',
      'taxonomy',
      'records',
    ]);
    // jsonb gives a taxonomy's keys back in an order of its own; sorted keys stand in for it here.
    const read = {
      records: example.records,
      taxonomy: JSON.parse(stableStringify(example.taxonomy)) as Taxonomy,
      publishedAt: example.publishedAt,
      generation: example.generation,
      snapshotId: example.snapshotId,
      project: example.project,
    };
    expect(serializeSnapshot(read)).toBe(written);
    expect(serializeSnapshot(snapshotSchema.parse(JSON.parse(written)))).toBe(written);
  });
});

describe('the example taxonomy snapshot', () => {
  const FILE = new URL('./testing/example-taxonomy-snapshot.json', import.meta.url);

  it('is the serializer’s bytes, which Crowdio keeps a copy of', async () => {
    const written = serializeSnapshot(exampleTaxonomySnapshot());
    // WRITE_EXAMPLE=1 writes it anew, after a change to the example or the serializer that's meant.
    if (process.env.WRITE_EXAMPLE === '1') await writeFile(FILE, written);
    expect(await readFile(FILE, 'utf8')).toBe(written);
  });

  it('is what the contract shows: version 2 with its merge, and three records placed in it', () => {
    const { taxonomy, records, ...head } = exampleTaxonomySnapshot();
    expect(head).toEqual({
      project: 'crowdio-audio-products',
      snapshotId: 'sn_00000000000000000003',
      generation: 3,
      publishedAt: '2026-11-02T09:14:00.000Z',
    });
    expect(taxonomy).toMatchObject({
      version: 2,
      migrations: [{ version: 2, kind: 'merge', subject: 'shelf', from: tx(11), to: tx(12) }],
    });
    expect(taxonomy!.shelves.find((shelf) => shelf.id === tx(11))).toMatchObject({
      slug: 'preamps',
      retiredIn: 2,
    });
    const BERTTI = 'https://chordelectronics.co.uk/product/bertti';
    const LCD_X = 'https://www.audeze.com/products/lcd-x';
    const QUTEST = 'https://chordelectronics.co.uk/product/qutest';
    const by = (sourceUrl: string, method: string, confidence: number) => ({
      sourceUrl,
      fetchedAt: '2026-11-02T06:00:00.000Z',
      method,
      confidence,
    });
    expect(records).toEqual([
      {
        canonicalId: 'sp_00000000000000000001',
        fields: {
          brand: 'Chord Electronics',
          name: 'BerTTi',
          officialUrl: BERTTI,
          shelf: tx(12),
          functions: [tx(3)],
          features: { [tx(16)]: [tx(19)] },
          category: 'Amplifiers',
        },
        provenance: {
          brand: by(BERTTI, 'rule', 1),
          name: by(BERTTI, 'jsonld', 0.9),
          officialUrl: by(BERTTI, 'rule', 1),
          shelf: by(BERTTI, 'human', 1),
          functions: by(BERTTI, 'human', 1),
          features: by(BERTTI, 'human', 1),
          category: by(BERTTI, 'human', 1),
        },
      },
      {
        canonicalId: 'sp_00000000000000000002',
        fields: {
          brand: 'Audeze',
          name: 'LCD-X',
          officialUrl: LCD_X,
          shelf: tx(6),
          functions: [tx(4)],
          features: { [tx(13)]: [tx(14)] },
          category: 'Headphones',
        },
        provenance: {
          brand: by(LCD_X, 'jsonld', 0.9),
          name: by(LCD_X, 'jsonld', 0.9),
          officialUrl: by(LCD_X, 'rule', 1),
          shelf: by(LCD_X, 'llm', 0.96),
          functions: by(LCD_X, 'llm', 0.96),
          features: by(LCD_X, 'llm', 0.95),
          category: by(LCD_X, 'llm', 0.96),
        },
      },
      {
        canonicalId: 'sp_00000000000000000003',
        fields: {
          brand: 'Chord Electronics',
          name: 'Qutest',
          officialUrl: QUTEST,
          shelf: tx(8),
          functions: [tx(1)],
          features: {},
          category: 'DACs',
        },
        provenance: {
          brand: by(QUTEST, 'rule', 1),
          name: by(QUTEST, 'jsonld', 0.9),
          officialUrl: by(QUTEST, 'rule', 1),
          shelf: by(QUTEST, 'rule', 1),
          functions: by(QUTEST, 'rule', 1),
          category: by(QUTEST, 'rule', 1),
        },
      },
    ]);
  });
});
