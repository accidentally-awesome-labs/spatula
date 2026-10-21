import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import { lineupNote, matchEvidence, nameDifference } from './match-evidence';

const parsed = parseDefinition({
  dataset: 'audio-products',
  recordTypes: {
    product: {
      identity: { identifiers: ['gtins', 'mpns'], keys: [['brand', 'name']] },
      fields: {
        brand: { type: 'text', required: true },
        name: { type: 'text', required: true },
        category: { type: 'enum', values: ['Headphones'] },
        gtins: { type: 'gtin', list: true, identifier: true },
        mpns: { type: 'text', list: true, identifier: true, scope: 'brand' },
        specs: { type: 'specs' },
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

describe('matchEvidence', () => {
  it('shows the names, the identifiers, the values side by side, the editions, and the lineup', () => {
    expect(
      matchEvidence({
        recordType: product,
        page: {
          url: 'https://maker.example/p/dt-71-ie',
          values: {
            brand: ['beyerdynamic'],
            name: ['DT 71 IE'],
            gtins: ['04010118471063'],
            mpns: ['DT71IE'],
            specs: [
              { label: 'Impedance', value: '16 Ω' },
              { label: 'Tuning', value: 'Neutral' },
              { label: 'Cable', value: 'MMCX' },
            ],
          },
        },
        entity: {
          url: 'https://maker.example/p/dt-70-ie',
          values: {
            brand: ['beyerdynamic'],
            name: ['DT 70 IE'],
            gtins: ['04010118471070'],
            specs: [
              { label: 'impedance', value: '16 Ω' },
              { label: 'Tuning', value: 'V-shaped' },
              { label: 'Weight', value: '5 g' },
            ],
          },
        },
        editions: ['DT 70 IE Black'],
        lineup: [
          { name: 'DT 72 IE', keptApart: false },
          { name: 'DT 73 IE', keptApart: true },
        ],
      }),
    ).toBe(
      [
        'Record A (https://maker.example/p/dt-71-ie): the page asked about.',
        'Record B (https://maker.example/p/dt-70-ie): the record it may belong to.',
        '',
        'Names:',
        'A: DT 71 IE',
        'B: DT 70 IE',
        'A has 71 where B has 70',
        '',
        'Identifiers:',
        '- gtins: A gives 04010118471063; B gives 04010118471070. None match.',
        '- mpns: A gives DT71IE; B gives none.',
        '',
        'Specifications:',
        'The same in both:',
        '- brand: beyerdynamic',
        '- Impedance: 16 Ω',
        'Different:',
        '- Tuning: A Neutral; B V-shaped',
        'Only in A:',
        '- Cable: MMCX',
        'Only in B:',
        '- Weight: 5 g',
        '',
        'B’s known editions: DT 70 IE Black',
        '',
        'Other records with the same brand, each already a record of its own:',
        '- DT 72 IE',
        '- DT 73 IE (a person kept it apart from B)',
      ].join('\n'),
    );
  });

  it('says which identifiers match, and shows at most 20 values of a field', () => {
    const mpns = Array.from({ length: 25 }, (_, n) => `M${n}`);
    expect(
      matchEvidence({
        recordType: product,
        page: {
          url: 'https://maker.example/p/a',
          values: { gtins: ['04010118471063', '04010118471070'], mpns },
        },
        entity: { url: 'https://maker.example/p/b', values: { gtins: ['04010118471070'] } },
      }),
    ).toBe(
      [
        'Record A (https://maker.example/p/a): the page asked about.',
        'Record B (https://maker.example/p/b): the record it may belong to.',
        '',
        'Identifiers:',
        '- gtins: A gives 04010118471063, 04010118471070; B gives 04010118471070. Both give 04010118471070.',
        `- mpns: A gives ${mpns.slice(0, 20).join(', ')}; B gives none.`,
      ].join('\n'),
    );
  });

  it('shows a missing name as none, and leaves out every section with nothing in it', () => {
    expect(
      matchEvidence({
        recordType: product,
        page: { url: 'https://maker.example/p/a', values: { name: ['HD 650'] } },
        entity: { url: 'https://maker.example/p/b', values: {} },
        editions: [],
        lineup: [],
      }),
    ).toBe(
      [
        'Record A (https://maker.example/p/a): the page asked about.',
        'Record B (https://maker.example/p/b): the record it may belong to.',
        '',
        'Names:',
        'A: HD 650',
        'B: (none)',
      ].join('\n'),
    );
  });
});

describe('nameDifference', () => {
  it('calls out the words one name adds, or has in place of the other’s', () => {
    expect(nameDifference('Hugo 2', 'Hugo')).toBe('A adds: 2');
    expect(nameDifference('Hugo', 'Hugo 2')).toBe('B adds: 2');
    expect(nameDifference('DT 990 PRO X', 'DT 990 PRO')).toBe('A adds: X');
    expect(nameDifference('EL Amp', 'EL Amp II+')).toBe('B adds: II +');
    expect(nameDifference('DT 71 IE', 'DT 70 IE')).toBe('A has 71 where B has 70');
    expect(nameDifference('HD 650', 'HD-650')).toBe('The names have the same words.');
  });
});

describe('lineupNote', () => {
  it('keeps the lineup in a decision’s evidence text, and says nothing of none', () => {
    expect(lineupNote([])).toBe('');
    expect(
      lineupNote([
        { name: 'DT 72 IE', keptApart: false },
        { name: 'DT 73 IE', keptApart: true },
      ]),
    ).toBe('Shown beside it: DT 72 IE; DT 73 IE (a person kept it apart from B).');
  });
});
