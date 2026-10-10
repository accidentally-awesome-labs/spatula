import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import { identityClaims, resolveIdentity, textKey } from './identity';

const parsed = parseDefinition({
  dataset: 'audio-products',
  recordTypes: {
    product: {
      identity: { identifiers: ['gtins', 'mpns'], keys: [['brand', 'name']] },
      fields: {
        brand: { type: 'text', required: true },
        name: { type: 'text', required: true },
        gtins: { type: 'gtin', list: true, identifier: true },
        mpns: { type: 'text', list: true, identifier: true, scope: 'brand' },
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

describe('textKey', () => {
  it('ignores case, accents, spaces, and punctuation', () => {
    expect(textKey('HD 660S2')).toBe('hd660s2');
    expect(textKey('hd-660 s2')).toBe('hd660s2');
    expect(textKey('Café Crème')).toBe('cafecreme');
    expect(textKey('100-LX-1018-00')).toBe('100lx101800');
  });

  it('keeps plus signs, so the Magni 3 and the Magni 3+ stay apart', () => {
    expect(textKey('Magni 3+')).toBe('magni3plus');
    expect(textKey('Magni 3 Plus')).toBe('magni3plus');
    expect(textKey('Magni 3')).not.toBe(textKey('Magni 3+'));
  });
});

describe('identityClaims', () => {
  it('lists GTINs, then part numbers within their brand, then the brand and name', () => {
    expect(
      identityClaims(product, {
        brand: ['Audeze'],
        name: ['LCD-X'],
        gtins: ['00819343015004'],
        mpns: ['100-LX-1018-00'],
      }),
    ).toEqual([
      { value: 'gtins:00819343015004', rank: 0 },
      { value: 'mpns:audeze:100lx101800', rank: 1 },
      { value: 'key0:audeze|lcdx', rank: 2 },
    ]);
  });

  it('skips part numbers without a brand, and keys with a missing part', () => {
    expect(identityClaims(product, { name: ['LCD-X'], mpns: ['100-LX-1018-00'] })).toEqual([]);
    expect(identityClaims(product, { brand: ['Audeze'], gtins: ['00819343015004'] })).toEqual([
      { value: 'gtins:00819343015004', rank: 0 },
    ]);
  });

  it('skips part numbers whose brand has no letters or digits to key it by', () => {
    expect(
      identityClaims(product, { brand: ['&'], name: ['LCD-X'], mpns: ['100-LX-1018-00'] }),
    ).toEqual([]);
  });
});

describe('resolveIdentity', () => {
  const owners = new Map([
    ['gtins:00819343015004', 'sp_a'],
    ['key0:audeze|lcdx', 'sp_b'],
  ]);

  it('follows the strongest claim that has an owner', () => {
    expect(
      resolveIdentity(
        [
          { value: 'gtins:00819343015004', rank: 0 },
          { value: 'key0:audeze|lcdx', rank: 2 },
        ],
        owners,
      ),
    ).toEqual({ kind: 'existing', entityId: 'sp_a' });
    expect(resolveIdentity([{ value: 'key0:audeze|lcdx', rank: 2 }], owners)).toEqual({
      kind: 'existing',
      entityId: 'sp_b',
    });
  });

  it('is new when no claim has an owner, and unresolvable without claims', () => {
    expect(resolveIdentity([{ value: 'gtins:04006381333931', rank: 0 }], owners)).toEqual({
      kind: 'new',
    });
    expect(resolveIdentity([], owners)).toEqual({ kind: 'unresolvable' });
  });
});
