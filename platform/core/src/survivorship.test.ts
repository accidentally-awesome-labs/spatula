import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import { survive, type StatementView } from './survivorship';

const parsed = parseDefinition({
  dataset: 'audio-products',
  recordTypes: {
    product: {
      identity: { identifiers: ['gtins'], keys: [['brand', 'name']] },
      fields: {
        brand: { type: 'text', required: true },
        name: { type: 'text', required: true },
        gtins: { type: 'gtin', list: true, identifier: true },
        specs: { type: 'specs', llm: true },
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

const at = (minute: number) => `2026-10-10T00:${String(minute).padStart(2, '0')}:00.000Z`;
function statement(
  overrides: Partial<StatementView> & Pick<StatementView, 'property' | 'value'>,
): StatementView {
  return {
    valueKey:
      typeof overrides.value === 'string' ? overrides.value : JSON.stringify(overrides.value),
    method: 'jsonld',
    confidence: 0.9,
    lastSeen: at(0),
    sourceUrl: 'https://maker.example/a',
    position: null,
    ...overrides,
  };
}

describe('survive', () => {
  it('lets the more trusted method win a single value, then the more recent sighting', () => {
    const results = survive(product, [
      statement({ property: 'brand', value: 'AUDEZE', method: 'jsonld', lastSeen: at(5) }),
      statement({ property: 'brand', value: 'Audeze', method: 'rule', confidence: 1 }),
      statement({ property: 'name', value: 'LCD-X (2021)', lastSeen: at(1) }),
      statement({ property: 'name', value: 'LCD-X', lastSeen: at(2) }),
      statement({
        property: 'name',
        value: 'Audeze LCD-X padded',
        method: 'opengraph',
        lastSeen: at(9),
      }),
    ]);
    expect(results.get('brand')).toEqual({
      values: ['Audeze'],
      provenance: {
        sourceUrl: 'https://maker.example/a',
        fetchedAt: at(0),
        method: 'rule',
        confidence: 1,
      },
    });
    expect(results.get('name')?.values).toEqual(['LCD-X']);
  });

  it('combines identifiers from every source, explained by the best, with the lowest confidence kept', () => {
    const results = survive(product, [
      statement({ property: 'gtins', value: '00819343015004', confidence: 0.8, position: 0 }),
      statement({
        property: 'gtins',
        value: '04006381333931',
        position: 1,
        sourceUrl: 'https://store.example/b',
      }),
      statement({
        property: 'gtins',
        value: '00819343015004',
        method: 'opengraph',
        confidence: 0.5,
        position: 0,
      }),
    ]);
    // The 0.9 statement is the best; the opengraph duplicate loses to the jsonld one and isn't kept.
    expect(results.get('gtins')).toEqual({
      values: ['00819343015004', '04006381333931'],
      provenance: {
        sourceUrl: 'https://store.example/b',
        fetchedAt: at(0),
        method: 'jsonld',
        confidence: 0.8,
      },
    });
  });

  it('keeps one value per spec label, the newest, in page order', () => {
    const results = survive(product, [
      statement({
        property: 'specs',
        value: { label: 'Weight', value: '612 g' },
        method: 'llm',
        position: 1,
      }),
      statement({
        property: 'specs',
        value: { label: 'Impedance', value: '20 Ω' },
        method: 'llm',
        position: 0,
      }),
      statement({
        property: 'specs',
        value: { label: 'weight', value: '600 g' },
        method: 'llm',
        position: 1,
        lastSeen: at(3),
      }),
    ]);
    expect(results.get('specs')?.values).toEqual([
      { label: 'Impedance', value: '20 Ω' },
      { label: 'weight', value: '600 g' },
    ]);
  });

  it('leaves out fields without statements', () => {
    expect(survive(product, [statement({ property: 'name', value: 'LCD-X' })]).has('brand')).toBe(
      false,
    );
  });
});
