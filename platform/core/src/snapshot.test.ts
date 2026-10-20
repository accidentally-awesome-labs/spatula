import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import { basePages, type EntityMember } from './editions';
import { buildRecords, snapshotSchema } from './snapshot';
import type { StatementView } from './survivorship';

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
