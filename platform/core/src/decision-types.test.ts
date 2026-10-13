import { describe, expect, it } from 'vitest';
import {
  classifyCriteria,
  classifyQuestion,
  classifyRule,
  classifyState,
  matchEvidence,
  matchQuestion,
  NONE_OF_THESE,
  stateEvidence,
  stateHash,
} from './decision-types';
import type { FieldDef } from './fields';
import { parsePage } from './page';

const UNDESCRIBED: FieldDef = {
  type: 'enum',
  required: true,
  list: false,
  identifier: false,
  llm: false,
  decide: true,
  values: ['Headphones', 'In-ear monitors', 'DAC/Amp'],
};
const CATEGORY: FieldDef = {
  ...UNDESCRIBED,
  description: 'In-ear monitors sit in the ear canal; DAC/Amp is one unit that does both.',
};

const PAGE = parsePage(
  '<html><head><title>CRBN2 Electrostatic Headphone - Audeze</title>' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"CRBN2","category":"Headphones"}</script>' +
    '</head><body><main><h1>CRBN2</h1></main></body></html>',
  'https://www.audeze.com/products/crbn2',
);

const ld = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
/** A page whose head holds `html`. */
const headOf = (html: string) =>
  parsePage(`<html><head>${html}</head><body></body></html>`, 'https://maker.example/p/x');

describe('classifying a page', () => {
  it('asks which value its one product has, or none', () => {
    expect(classifyQuestion('category', CATEGORY)).toEqual({
      type: 'choice',
      prompt: 'Which category does the one product this page is about have?',
      options: ['Headphones', 'In-ear monitors', 'DAC/Amp', NONE_OF_THESE],
    });
    expect(classifyCriteria(CATEGORY)).toContain(
      'About the values: In-ear monitors sit in the ear canal; DAC/Amp is one unit that does both.',
    );
  });

  it('says how to classify, and describes the values only when the field does', () => {
    const criteria = classifyCriteria(UNDESCRIBED);
    expect(criteria).not.toContain('About the values');
    expect(criteria).toContain('Choose the value that fits the one product the page is about');
    expect(criteria).toContain(
      `Choose "${NONE_OF_THESE}" when the page is about no single product`,
    );
    expect(classifyCriteria(CATEGORY).startsWith(criteria)).toBe(true);
  });

  it('builds its state from what the page says about itself and what it says the product is', async () => {
    const state = classifyState(PAGE, {
      name: ['CRBN2'],
      brand: ['Audeze'],
      specs: [{ label: 'Type', value: 'Electrostatic' }],
    });
    expect(state).toEqual({
      url: 'https://www.audeze.com/products/crbn2',
      title: 'CRBN2 Electrostatic Headphone - Audeze',
      breadcrumbs: [],
      types: ['Product'],
      categories: ['Headphones'],
      values: { brand: ['Audeze'], name: ['CRBN2'], specs: ['Type: Electrostatic'] },
    });
    expect(stateEvidence(state)).toBe(
      [
        'Address: https://www.audeze.com/products/crbn2',
        'Title: CRBN2 Electrostatic Headphone - Audeze',
        'Structured data types: Product',
        'Structured data category: Headphones',
        'brand: Audeze',
        'name: CRBN2',
        'specs: Type: Electrostatic',
      ].join('\n'),
    );
    // The same state hashes the same, whatever order its values were gathered in.
    const again = classifyState(PAGE, {
      specs: [{ label: 'Type', value: 'Electrostatic' }],
      brand: ['Audeze'],
      name: ['CRBN2'],
    });
    expect(await stateHash(again)).toBe(await stateHash(state));
  });

  it('lets structured data answer when its category is one of the values', () => {
    expect(classifyRule(classifyState(PAGE, {}), CATEGORY)).toBe('Headphones');
    const other = parsePage('<title>Ear pads</title>', 'https://www.audeze.com/products/pads');
    expect(classifyRule(classifyState(other, {}), CATEGORY)).toBeNull();
  });

  it('matches a category to a value without regard to case, and answers with the value as written', () => {
    const answer = (...categories: string[]) =>
      classifyRule(
        classifyState(
          headOf(categories.map((category) => ld({ '@type': 'Product', category })).join('')),
          {},
        ),
        CATEGORY,
      );
    expect(answer('dac/AMP')).toBe('DAC/Amp');
    expect(answer('IN-EAR MONITORS')).toBe('In-ear monitors');
    expect(answer('\n  Headphones \t')).toBe('Headphones');
    // The first category that is one of the values answers.
    expect(answer('Audio', 'in-ear monitors', 'Headphones')).toBe('In-ear monitors');
    expect(answer('Audio', 'Earbuds')).toBeNull();
  });

  it('never lets structured data answer “None of these”, whatever a page calls its category', () => {
    const state = classifyState(headOf(ld({ '@type': 'Product', category: NONE_OF_THESE })), {});
    expect(state.categories).toEqual([NONE_OF_THESE]);
    expect(classifyRule(state, CATEGORY)).toBeNull();
  });

  it('reads categories from products and product groups only, and each type once', () => {
    const state = classifyState(
      headOf(
        ld([
          { '@type': 'Organization', category: 'Audio retailer' },
          { '@type': 'ProductGroup', category: 'Headphones' },
          { '@type': ['Product', 'Thing'], category: 'DAC/Amp' },
          { '@type': 'Product', category: 'In-ear monitors' },
          { '@type': 'Offer', category: 'Sale' },
        ]),
      ),
      {},
    );
    expect(state.categories).toEqual(['Headphones', 'DAC/Amp', 'In-ear monitors']);
    expect(state.types).toEqual(['Organization', 'ProductGroup', 'Product', 'Thing', 'Offer']);
  });

  it('keeps 20 of a property’s values, and 20 types and categories', () => {
    const many = (prefix: string) => Array.from({ length: 25 }, (_, n) => `${prefix}${n}`);
    const state = classifyState(
      headOf(
        ld(
          many('Type').map((type) => ({
            '@type': ['Product', type],
            category: `Category ${type}`,
          })),
        ),
      ),
      { gtins: many('0'), specs: many('s').map((label) => ({ label, value: 'x' })) },
    );
    expect(state.types).toEqual(['Product', ...many('Type').slice(0, 19)]);
    expect(state.categories).toEqual(
      many('Type')
        .slice(0, 20)
        .map((type) => `Category ${type}`),
    );
    expect(state.values.gtins).toEqual(many('0').slice(0, 20));
    expect(state.values.specs).toHaveLength(20);
  });

  it('writes only what a state has', () => {
    const state = classifyState(headOf(''), {});
    expect(stateEvidence(state)).toBe('Address: https://maker.example/p/x');
    expect(stateEvidence({ ...state, title: 'Atom', breadcrumbs: ['Home', 'Audio', 'DACs'] })).toBe(
      [
        'Address: https://maker.example/p/x',
        'Title: Atom',
        'Breadcrumbs: Home > Audio > DACs',
      ].join('\n'),
    );
  });

  it('hashes a state to 64 hex digits that change with the state, not with its key order', async () => {
    const state = classifyState(PAGE, { name: ['CRBN2'] });
    expect(await stateHash(state)).toMatch(/^[0-9a-f]{64}$/u);
    expect(await stateHash({ ...state, title: 'Another title' })).not.toBe(await stateHash(state));
    expect(await stateHash({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
      await stateHash({ b: [{ d: 3, c: 2 }], a: 1 }),
    );
  });
});

describe('a hostile page’s classification state', () => {
  /** Every string in a value, however deep. */
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

  it('holds what a page says about itself to a size and a form a database takes', () => {
    // Postgres refuses U+0000 in text, and jsonb refuses it and a lone surrogate too. A JSON-LD
    // string can hold a lone surrogate (\ud800), and a title can hold a raw NUL.
    const state = classifyState(
      headOf(
        '<title>CRBN2\u0000 Headphone</title>' +
          ld({
            '@type': ['Product', `Long${'x'.repeat(5_000)}`, 'Bad\ud800Type'],
            name: 'CRBN2',
            category: 'Head\ud800phones',
          }) +
          ld({
            '@type': 'BreadcrumbList',
            itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Audio\u0000 gear' }],
          }),
      ),
      {},
    );
    expect(state).toMatchObject({
      title: 'CRBN2 Headphone',
      breadcrumbs: ['Audio gear'],
      types: ['Product', `Long${'x'.repeat(196)}`, 'Bad\uFFFDType', 'BreadcrumbList'],
      categories: ['Head\uFFFDphones'],
    });
    expect(strings(state).every((text) => text.isWellFormed() && !text.includes('\u0000'))).toBe(
      true,
    );
    expect(stateEvidence(state)).not.toContain('\u0000');
  });

  it('cuts a long category between characters, not through one', () => {
    // 199 letters and an emoji of two code units: the cut at 200 would split the pair.
    const category = `${'a'.repeat(199)}😀`;
    const state = classifyState(headOf(ld({ '@type': 'Product', category })), {});
    expect(state.categories).toEqual([`${'a'.repeat(199)}\uFFFD`]);
  });

  it('ends a cut category without the space it was cut after', () => {
    const state = classifyState(
      headOf(ld({ '@type': 'Product', category: `${'a'.repeat(199)} and more` })),
      {},
    );
    expect(state.categories).toEqual(['a'.repeat(199)]);
  });

  it('leaves out words that are nothing but control characters, and a title that is', () => {
    const state = classifyState(
      headOf(
        '<title>\u0000\u0001</title>' +
          ld({ '@type': ['Product', '\u0000'], category: '\u0000 ' }) +
          ld({
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: '\u0001' },
              { '@type': 'ListItem', position: 2, name: 'Audio' },
            ],
          }),
      ),
      {},
    );
    expect(state).toMatchObject({
      title: null,
      breadcrumbs: ['Audio'],
      types: ['Product', 'BreadcrumbList'],
      categories: [],
    });
  });
});

describe('matching a page to an entity', () => {
  it('asks whether two records are the same product, a variant, or different', () => {
    expect(matchQuestion()).toEqual({
      type: 'choice',
      prompt: 'Are these two records the same product?',
      options: ['same', 'variant', 'different'],
    });
    expect(
      matchEvidence({
        page: {
          url: 'https://maker.example/p/dt-770-80',
          values: { name: ['DT 770 PRO 80 Ohm'], gtins: ['04010118471067'] },
        },
        entity: {
          url: 'https://maker.example/p/dt-770-250',
          values: { name: ['DT 770 PRO 250 Ohm'], gtins: ['04010118471074'] },
        },
      }),
    ).toBe(
      [
        'Record A (https://maker.example/p/dt-770-80):',
        'gtins: 04010118471067',
        'name: DT 770 PRO 80 Ohm',
        '',
        'Record B (https://maker.example/p/dt-770-250):',
        'gtins: 04010118471074',
        'name: DT 770 PRO 250 Ohm',
      ].join('\n'),
    );
  });

  it('writes specs as label and value, at most 20 values of a property, and a record with none', () => {
    const mpns = Array.from({ length: 25 }, (_, n) => `M${n}`);
    const evidence = matchEvidence({
      page: {
        url: 'https://maker.example/p/a',
        values: { specs: [{ label: 'Impedance', value: '80 Ω' }], mpns },
      },
      entity: { url: 'https://maker.example/p/b', values: {} },
    });
    expect(evidence).toBe(
      [
        'Record A (https://maker.example/p/a):',
        `mpns: ${mpns.slice(0, 20).join('; ')}`,
        'specs: Impedance: 80 Ω',
        '',
        'Record B (https://maker.example/p/b):',
      ].join('\n'),
    );
  });
});
