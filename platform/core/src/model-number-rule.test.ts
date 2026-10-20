import { describe, expect, it } from 'vitest';
import { MATCH_OUTCOMES } from './decision-types';
import { parseDefinition, type RecordType } from './definition';
import {
  differsOnlyByModelMarks,
  modelNumberRule,
  nameField,
  nameWords,
  wordDifference,
} from './matching';

type Outcome = 'apart' | 'join' | 'edition';

/**
 * Run 1's 46 match questions (crowdio-audio-products), each the page's name against the record's,
 * with the owner's outcome (2026-10-20): every pair apart but the Club, an edition. The names are
 * each model's as its maker writes it, from the questions' notes and the pages' addresses (the
 * plan's ruling 1).
 */
const RUN_1: readonly (readonly [string, string, Outcome])[] = [
  ['AVENTHO 300', 'AVENTHO 100', 'apart'],
  ['DJ 300 PRO X Club', 'DJ 300 PRO X', 'edition'],
  ['DT 1990 PRO MKII', 'DT 1770 PRO MKII', 'apart'],
  ['DT 275 PRO', 'DT 270 PRO', 'apart'],
  ['DT 71 IE', 'DT 70 IE', 'apart'],
  ['DT 72 IE', 'DT 70 IE', 'apart'],
  ['DT 73 IE', 'DT 70 IE', 'apart'],
  ['DT 770 PRO X', 'DT 770 PRO', 'apart'],
  ['DT 770 PRO X', 'DT 700 PRO X', 'apart'],
  ['DT 900 PRO X', 'DT 700 PRO X', 'apart'],
  ['DT 990 PRO X', 'DT 990 PRO', 'apart'],
  ['MMX 150 wireless', 'MMX 100 wireless', 'apart'],
  ['MMX 230 wireless', 'MMX 100 wireless', 'apart'],
  ['MMX 330 PRO', 'MMX 300 PRO', 'apart'],
  ['Hugo 2', 'Hugo', 'apart'],
  ['Hugo TT', 'Hugo', 'apart'],
  ['Mojo 2', 'Mojo', 'apart'],
  ['SPM 1400 MkII', 'SPM 1200 MkII', 'apart'],
  ['SPM 14000 MkII', 'SPM 5000 Mk II', 'apart'],
  ['SPM 6000 MkII', 'SPM 5000 Mk II', 'apart'],
  ['ULTIMA PRE 2', 'ULTIMA PRE 3', 'apart'],
  ['ULTIMA 2', 'ULTIMA', 'apart'],
  ['ULTIMA 3', 'ULTIMA', 'apart'],
  ['ULTIMA 5', 'ULTIMA', 'apart'],
  ['ULTIMA 6', 'ULTIMA', 'apart'],
  ['Atom Amp+', 'Atom Amp 2', 'apart'],
  ['Atom DAC+', 'Atom DAC 2', 'apart'],
  ['Atom DAC', 'Atom DAC 2', 'apart'],
  ['EL Amp', 'EL Amp II+', 'apart'],
  ['EL DAC', 'EL DAC II+', 'apart'],
  ['Element III', 'Element II', 'apart'],
  ['Element IV', 'Element II', 'apart'],
  ['Armature Art 24', 'Armature Art 12', 'apart'],
  ['BLESSING3', 'BLESSING2', 'apart'],
  ['DAWN PRO 2', 'DAWN PRO', 'apart'],
  ['DISCDREAM 2', 'DISCDREAM', 'apart'],
  ['DISCDREAM 2 Ultra', 'DISCDREAM', 'apart'],
  ['ECHO-B', 'ECHO-A', 'apart'],
  ['EDGE2', 'EDGE', 'apart'],
  ['FreeDSP Pro', 'FreeDSP', 'apart'],
  ['Golden Ages 2', 'Golden Ages', 'apart'],
  ['MoonRiver 2 Ti', 'MoonRiver2', 'apart'],
  ['MoonRiver3', 'MoonRiver2', 'apart'],
  ['Space Travel 2 Ultra', 'Space Travel 2', 'apart'],
  ['SSR', 'SSP', 'apart'],
  ['Starfield II', 'Starfield', 'apart'],
];

/** Generation 2's names, some with marketing words after the model, all different products. */
const GENERATION_2: readonly (readonly [string, string])[] = [
  ['MM-100 Professional Headphones', 'MM-500 Professional Headphones'],
  ['IE 600', 'IE 900'],
  ['LCD-5 Flagship Headphones', 'LCD-4'],
  ['HD 660 S 2', 'HD 620 S'],
  ['LCD-2 Classic', 'LCD-X'],
  ['LCD-XC', 'LCD-X'],
];

const pair = ([a, b]: readonly [string, string, ...unknown[]]) => `${a} / ${b}`;
const settles = ([a, b]: readonly [string, string, ...unknown[]]) => differsOnlyByModelMarks(a, b);

describe('the model-number rule on run 1’s pairs', () => {
  it('never keeps apart a pair the owner joined or called an edition', () => {
    for (const question of RUN_1) {
      if (question[2] !== 'apart') expect(settles(question), pair(question)).toBe(false);
    }
  });

  it('keeps 36 of the 46 apart, as the owner did, and leaves the other 10 to the decider', () => {
    expect(RUN_1).toHaveLength(46);
    const settled = RUN_1.filter(settles);
    expect(settled).toHaveLength(36);
    expect(settled.every(([, , outcome]) => outcome === 'apart')).toBe(true);
    expect(MATCH_OUTCOMES['other-model']).toBe('apart');
    expect(RUN_1.filter((question) => !settles(question)).map(pair)).toEqual([
      'DJ 300 PRO X Club / DJ 300 PRO X',
      'DT 770 PRO X / DT 770 PRO',
      'DT 990 PRO X / DT 990 PRO',
      'Hugo TT / Hugo',
      'DISCDREAM 2 Ultra / DISCDREAM',
      'ECHO-B / ECHO-A',
      'FreeDSP Pro / FreeDSP',
      'MoonRiver 2 Ti / MoonRiver2',
      'Space Travel 2 Ultra / Space Travel 2',
      'SSR / SSP',
    ]);
  });

  it('settles generation 2’s numbers under the same marketing words, and leaves its other names alone', () => {
    expect(GENERATION_2.filter(settles).map(pair)).toEqual([
      'MM-100 Professional Headphones / MM-500 Professional Headphones',
      'IE 600 / IE 900',
    ]);
  });
});

describe('the model-number rule', () => {
  it('settles the spec’s examples, in either order', () => {
    for (const [a, b] of [
      ['Hugo 2', 'Hugo'],
      ['DT 71 IE', 'DT 70 IE'],
      ['MM-100 Professional Headphones', 'MM-500 Professional Headphones'],
      ['SPM 14000 Mk II', 'SPM 5000 Mk II'],
      ['Element III', 'Element II'],
      ['EL Amp II+', 'EL Amp'],
      ['Atom DAC+', 'Atom DAC 2'],
    ] as const) {
      expect(differsOnlyByModelMarks(a, b), `${a} / ${b}`).toBe(true);
      expect(differsOnlyByModelMarks(b, a), `${b} / ${a}`).toBe(true);
    }
  });

  it('leaves alone a color, an X, equal names, names that differ by a word, and names without words', () => {
    for (const [a, b] of [
      ['HD 650', 'HD 650 Black'],
      ['DT 990 PRO X', 'DT 990 PRO'],
      ['HD 650', 'HD 650'],
      ['HD 650', 'HD-650'],
      ['Mk II', 'Mk 2'],
      ['Hugo TT', 'Hugo'],
      ['Echo A', 'Echo B'],
      ['DJ 300 PRO X Club', 'DJ 300 PRO X'],
      ['MoonRiver 2 Ti', 'MoonRiver 2'],
      ['Element I', 'Element II'],
      ['---', '...'],
    ] as const) {
      expect(differsOnlyByModelMarks(a, b), `${a} / ${b}`).toBe(false);
    }
  });

  it('is blind to brand words and marketing words', () => {
    for (const [a, b] of [
      ['Chord Hugo 2', 'Hugo'],
      ['Chord Hugo', 'Hugo 2'],
      ['beyerdynamic DT 990 PRO', 'DT 990 PRO'],
      ['64 Audio U12t', 'U12t'],
      ['LCD-5 Flagship Headphones', 'LCD-4'],
    ] as const) {
      expect(differsOnlyByModelMarks(a, b), `${a} / ${b}`).toBe(false);
    }
  });

  it('reads letters and digits apart, Roman numerals as numbers, Mk glued to one as two words, and + as plus', () => {
    const keys = (name: string) => nameWords(name).map((word) => word.key);
    expect(keys('MoonRiver2')).toEqual(['moonriver', '2']);
    expect(keys('SPM1400')).toEqual(['spm', '1400']);
    expect(keys('Café X')).toEqual(['cafe', 'x']);
    expect(nameWords('EL Amp II+')).toEqual([
      { text: 'EL', key: 'el' },
      { text: 'Amp', key: 'amp' },
      { text: 'II', key: '2' },
      { text: '+', key: 'plus' },
    ]);
    expect(nameWords('SPM 14000 MkII')).toEqual([
      { text: 'SPM', key: 'spm' },
      { text: '14000', key: '14000' },
      { text: 'Mk', key: 'mk' },
      { text: 'II', key: '2' },
    ]);
    expect(keys('Mk II')).toEqual(keys('Mk 2'));
    expect(keys('Atom DAC Plus')).toEqual(keys('Atom DAC+'));
    expect(wordDifference(nameWords('DT 71 IE'), nameWords('DT 70 IE'))).toEqual({
      onlyA: [{ text: '71', key: '71' }],
      onlyB: [{ text: '70', key: '70' }],
    });
    expect(wordDifference(nameWords('x y x'), nameWords('x'))).toEqual({
      onlyA: [
        { text: 'y', key: 'y' },
        { text: 'x', key: 'x' },
      ],
      onlyB: [],
    });
  });
});

describe('modelNumberRule', () => {
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

  it('compares the records’ names within one brand', () => {
    expect(nameField(product)).toBe('name');
    expect(
      modelNumberRule(
        product,
        { brand: ['Chord'], name: ['Hugo 2'] },
        { brand: ['Chord'], name: ['Hugo'] },
      ),
    ).toBe('other-model');
    expect(
      modelNumberRule(
        product,
        { brand: ['Chord'], name: ['Hugo 2'] },
        { brand: ['Chord Electronics'], name: ['Hugo'] },
      ),
    ).toBeNull();
    expect(
      modelNumberRule(product, { name: ['Hugo 2'] }, { brand: ['Chord'], name: ['Hugo'] }),
    ).toBeNull();
  });

  it('keeps a page apart only when it differs by model marks from every name the record carries', () => {
    const record = { brand: ['beyerdynamic'], name: ['DT 770 PRO', 'DT 770 PRO (2024)'] };
    expect(
      modelNumberRule(product, { brand: ['beyerdynamic'], name: ['DT 770 PRO'] }, record),
    ).toBeNull();
    expect(
      modelNumberRule(product, { brand: ['beyerdynamic'], name: ['DT 771 PRO'] }, record),
    ).toBeNull();
    expect(
      modelNumberRule(
        product,
        { brand: ['beyerdynamic'], name: ['DT 771 PRO'] },
        {
          brand: ['beyerdynamic'],
          name: ['DT 770 PRO', 'DT 772 PRO'],
        },
      ),
    ).toBe('other-model');
  });
});
