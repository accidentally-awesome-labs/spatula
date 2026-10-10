import { describe, expect, it } from 'vitest';
import { parseDefinition } from './definition';

const EVIDENCE = {
  robots: '2026-10-09',
  terms: {
    url: 'https://maker.example/policies/terms-of-service',
    checked: '2026-10-09',
    automatedAccess: 'not-mentioned',
  },
};

// Fixtures are edited freely below, so they're untyped.
function definition(overrides: Record<string, unknown> = {}): any {
  return {
    dataset: 'audio-products',
    recordTypes: {
      product: {
        pack: 'products/product',
        identity: { identifiers: ['gtins', 'mpns'], keys: [['brand', 'name']] },
        fields: {
          brand: { type: 'text', required: true, maxLength: 80 },
          name: { type: 'text', required: true, maxLength: 120 },
          category: { type: 'enum', required: true, values: ['Headphones', 'DAC/Amp'] },
          gtins: { type: 'gtin', list: true, identifier: true },
          mpns: { type: 'text', list: true, identifier: true, scope: 'brand', maxLength: 80 },
          officialUrl: { type: 'url' },
          specs: { type: 'specs', llm: true },
        },
      },
    },
    sources: [
      {
        id: 'maker',
        kind: 'pages',
        recordType: 'product',
        pages: ['https://maker.example/products/one'],
        fixed: { brand: 'Maker', category: 'Headphones' },
        extract: { name: { css: 'h1' }, officialUrl: { url: 'canonical' } },
        evidence: EVIDENCE,
      },
    ],
    policy: { purposes: ['ai-input'] },
    ...overrides,
  };
}

function issuesOf(input: unknown): string[] {
  const result = parseDefinition(input);
  return result.ok ? [] : result.issues;
}

describe('parseDefinition', () => {
  it('reads a definition and fills in defaults', () => {
    const result = parseDefinition(definition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = result.definition.recordTypes.product?.fields;
    expect(fields?.specs).toMatchObject({ type: 'specs', list: true, llm: true, required: false });
    expect(fields?.brand).toMatchObject({ identifier: false, list: false, llm: false });
    expect(result.definition.policy).toEqual({ purposes: ['ai-input'], perHostIntervalMs: 1000 });
  });

  it('refuses unknown keys, and says where', () => {
    expect(issuesOf(definition({ budget: { monthlyUsd: 40 } }))).toEqual([
      expect.stringContaining('budget'),
    ]);
  });

  it('wants exactly one record type', () => {
    const two = definition();
    two.recordTypes = { ...two.recordTypes, offer: two.recordTypes.product };
    expect(issuesOf(two)).toContain(
      'recordTypes: Declare exactly one record type. Datasets with several arrive in a later version.',
    );
  });

  it('checks fixed values against their fields', () => {
    const bad = definition();
    bad.sources[0].fixed = { category: 'Speakers', colour: 'red' };
    expect(issuesOf(bad)).toEqual(
      expect.arrayContaining([
        'sources.0.fixed.category: “Speakers” is not one of Headphones, DAC/Amp.',
        'sources.0.fixed.colour: There’s no field called colour.',
      ]),
    );
  });

  it('keeps the LLM away from fields that identify a record', () => {
    const bad = definition();
    bad.recordTypes.product.fields.name = {
      type: 'text',
      required: true,
      maxLength: 120,
      llm: true,
    };
    expect(issuesOf(bad)).toEqual(
      expect.arrayContaining([
        'recordTypes.product.fields.name.llm: In this version, the LLM fills specs fields only.',
        'recordTypes.product.fields.name.llm: Fields that identify a record come from structured data or declared rules, never the LLM.',
      ]),
    );
  });

  it('refuses sources whose terms forbid automated access', () => {
    const bad = definition();
    bad.sources[0].evidence = {
      ...EVIDENCE,
      terms: { ...EVIDENCE.terms, automatedAccess: 'forbidden' },
    };
    expect(issuesOf(bad)).toContain(
      'sources.0.evidence.terms.automatedAccess: The site’s terms forbid automated access, so Spatula can’t collect this source.',
    );
  });

  it('checks rules: selectors must parse, and only url fields take the page address', () => {
    const bad = definition();
    bad.sources[0].extract = { name: { css: 'h1[' }, brand: { url: 'canonical' } };
    bad.sources[0].fixed = { category: 'Headphones' };
    const issues = issuesOf(bad);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^sources\.0\.extract\.name\.css: The selector doesn’t parse/u),
        'sources.0.extract.brand: Only url fields can take the page address.',
      ]),
    );
  });

  it('refuses a field that is both fixed and extracted, and pages listed twice', () => {
    const bad = definition();
    bad.sources[0].fixed = { name: 'One', category: 'Headphones' };
    bad.sources.push({ ...bad.sources[0], id: 'again' });
    expect(issuesOf(bad)).toEqual(
      expect.arrayContaining([
        'sources.0.extract.name: name is fixed, so it can’t also be extracted.',
        'sources.1.pages: https://maker.example/products/one is listed twice.',
      ]),
    );
  });

  it('checks identity: identifiers, keys, and scopes must be usable fields', () => {
    const bad = definition();
    bad.recordTypes.product.identity = { identifiers: ['officialUrl'], keys: [['brand', 'gtins']] };
    expect(issuesOf(bad)).toEqual(
      expect.arrayContaining([
        'recordTypes.product.identity.identifiers.0: Mark officialUrl as an identifier (identifier: true).',
        'recordTypes.product.identity.keys.0.1: Key fields must be single text or enum values; gtins isn’t.',
      ]),
    );
  });

  it('wants https pages and real dates', () => {
    const bad = definition();
    bad.sources[0].pages = ['http://maker.example/products/one'];
    bad.sources[0].evidence = { ...EVIDENCE, robots: '9 October' };
    expect(issuesOf(bad)).toEqual(
      expect.arrayContaining([
        'sources.0.pages.0: Use an https:// address.',
        'sources.0.evidence.robots: Write the date as YYYY-MM-DD.',
      ]),
    );
  });
});
