import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
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
});
