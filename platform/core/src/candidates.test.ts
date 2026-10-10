import { describe, expect, it } from 'vitest';
import { extractFromPage } from './candidates';
import { parseDefinition, type Definition, type Source } from './definition';
import type { RecordTypePack } from './pack';
import { parsePage } from './page';
import type { Candidate } from './statements';

const EVIDENCE = {
  robots: '2026-10-09',
  terms: {
    url: 'https://maker.example/terms',
    checked: '2026-10-09',
    automatedAccess: 'not-mentioned',
  },
};

function load(sources: unknown[]): Definition {
  const result = parseDefinition({
    dataset: 'audio-products',
    recordTypes: {
      product: {
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
    sources,
    policy: { purposes: ['ai-input'] },
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition;
}

const definition = load([
  {
    id: 'audeze',
    kind: 'pages',
    recordType: 'product',
    pages: ['https://www.audeze.com/products/lcd-x'],
    fixed: { brand: 'Audeze', category: 'Headphones' },
    extract: { officialUrl: { url: 'canonical' } },
    evidence: EVIDENCE,
  },
  {
    id: 'sennheiser',
    kind: 'pages',
    recordType: 'product',
    pages: ['https://us.sennheiser-hearing.com/products/hd-650'],
    fixed: { brand: 'Sennheiser', category: 'Headphones' },
    extract: { name: { css: 'h1' }, officialUrl: { url: 'canonical' } },
    evidence: EVIDENCE,
  },
]);
const recordType = definition.recordTypes.product!;
const [audeze, sennheiser] = definition.sources as [Source, Source];

/** A stand-in pack that finds exactly the candidates it's given, as structured data. */
function packFinding(candidates: Candidate[], finish?: RecordTypePack['finish']): RecordTypePack {
  return {
    fields: { brand: { type: 'text', list: false }, name: { type: 'text', list: false } },
    extract: () => candidates,
    finish,
  };
}
const jsonld = (property: string, raw: unknown, path: string, confidence = 0.9): Candidate => ({
  property,
  raw,
  method: 'jsonld',
  path,
  confidence,
});

const AUDEZE_PAGE = parsePage(
  '<link rel="canonical" href="https://www.audeze.com/products/lcd-x"><h1>LCD-X</h1>',
  'https://www.audeze.com/products/lcd-x?variant=1',
);
const sennheiserPage = (h1: string) =>
  parsePage(
    `<link rel="canonical" href="/products/hd-650"><main>${h1}<p>Impedance 300 Ω</p></main>`,
    'https://us.sennheiser-hearing.com/products/hd-650',
  );

describe('extractFromPage', () => {
  it('reads fixed values and declared rules, and they replace the pack for their fields', () => {
    const pack = packFinding([
      jsonld('name', 'LCD-X', 'jsonld[0].name'),
      jsonld('brand', 'AUDEZE', 'jsonld[0].brand'),
      jsonld('gtins', '12345', 'jsonld[0].gtin13'),
      jsonld('gtins', '819343015004', 'jsonld[0].mpn', 0.8),
      { property: 'name', raw: 'LCD-X', method: 'opengraph', path: 'og:title', confidence: 0.6 },
    ]);
    const result = extractFromPage({ page: AUDEZE_PAGE, source: audeze, recordType, pack });
    expect(result.statements.map((s) => [s.property, s.value, s.method, s.confidence])).toEqual([
      ['brand', 'Audeze', 'rule', 1],
      ['category', 'Headphones', 'rule', 1],
      ['officialUrl', 'https://www.audeze.com/products/lcd-x', 'rule', 0.9],
      ['name', 'LCD-X', 'jsonld', 0.9],
      ['gtins', '00819343015004', 'jsonld', 0.8],
      ['name', 'LCD-X', 'opengraph', 0.6],
    ]);
    // The page's own "AUDEZE" never appears: the source fixes the brand.
    expect(result.rejected).toEqual([
      {
        property: 'gtins',
        path: 'jsonld[0].gtin13',
        reason: 'not a GTIN with a valid check digit',
      },
    ]);
    expect(result.missing).toEqual(['mpns', 'specs']);
  });

  it('takes a name only from the declared rule, never from a padded og:title', () => {
    const pack = packFinding([
      {
        property: 'name',
        raw: 'Sennheiser HD 650 Wired Open-Back Headphones',
        method: 'opengraph',
        path: 'og:title',
        confidence: 0.6,
      },
    ]);
    const result = extractFromPage({
      page: sennheiserPage('<h1>HD 650</h1>'),
      source: sennheiser,
      recordType,
      pack,
    });
    expect(result.statements.filter((s) => s.property === 'name')).toEqual([
      {
        property: 'name',
        value: 'HD 650',
        valueKey: 'HD 650',
        original: 'HD 650',
        method: 'rule',
        path: 'css:h1',
        confidence: 0.9,
        position: null,
      },
    ]);
  });

  it('leaves the name missing when the declared element is gone', () => {
    const pack = packFinding([
      {
        property: 'name',
        raw: 'Sennheiser HD 650 Wired',
        method: 'opengraph',
        path: 'og:title',
        confidence: 0.6,
      },
    ]);
    const result = extractFromPage({
      page: sennheiserPage(''),
      source: sennheiser,
      recordType,
      pack,
    });
    expect(result.statements.some((s) => s.property === 'name')).toBe(false);
    expect(result.missing).toContain('name');
  });

  it('numbers list values in page order and keeps one of each value per method', () => {
    const pack = packFinding([
      jsonld('gtins', '4006381333931', 'jsonld[0].gtin13'),
      jsonld('gtins', '4006381333931', 'jsonld[0].offers[0].gtin13'),
      jsonld('gtins', '036000291452', 'jsonld[0].offers[1].gtin12'),
    ]);
    const gtins = extractFromPage({
      page: AUDEZE_PAGE,
      source: audeze,
      recordType,
      pack,
    }).statements.filter((s) => s.property === 'gtins');
    expect(gtins.map((s) => [s.value, s.position])).toEqual([
      ['04006381333931', 0],
      ['00036000291452', 1],
    ]);
  });

  it('gives the pack’s last pass every candidate, declared ones included', () => {
    let seen: string[] = [];
    const pack = packFinding([jsonld('name', 'LCD-X', 'jsonld[0].name')], (all) => {
      seen = all.map((c) => c.path);
      return all;
    });
    extractFromPage({ page: AUDEZE_PAGE, source: audeze, recordType, pack });
    expect(seen).toEqual(['fixed', 'fixed', 'canonical', 'jsonld[0].name']);
  });

  it('works without a pack: only fixed values and declared rules', () => {
    const result = extractFromPage({ page: AUDEZE_PAGE, source: audeze, recordType, pack: null });
    expect(result.statements.map((s) => s.property)).toEqual(['brand', 'category', 'officialUrl']);
  });
});
