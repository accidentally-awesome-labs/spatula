import { parsePage, type Candidate } from '@spatula/core';
import { describe, expect, it } from 'vitest';
import { looksLikeGtin, productPack } from './index';

const page = (head: string) =>
  parsePage(`<html><head>${head}</head><body></body></html>`, 'https://maker.example/products/x');
const ld = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('productPack.extract', () => {
  it('reads a store’s product whose mpn is its barcode as a GTIN, not a part number', () => {
    const candidates = productPack.extract(
      page(
        ld({ '@context': 'http://schema.org', '@type': 'Organization', name: 'Audeze' }) +
          ld({
            '@context': 'http://schema.org/',
            '@type': 'Product',
            name: 'LCD-X',
            brand: { '@type': 'Thing', name: 'Audeze' },
            sku: '100-LX-1018-00',
            mpn: '819343015004',
            offers: { '@type': 'Offer', price: 1199, priceCurrency: 'USD' },
          }) +
          ld({
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: 'LCD-X',
            brand: { '@type': 'Brand', name: 'Audeze' },
            offers: { '@type': 'Offer', sku: '100-LX-1018-00' },
          }),
      ),
    );
    expect(candidates).toEqual([
      { property: 'name', raw: 'LCD-X', method: 'jsonld', path: 'jsonld[1].name', confidence: 0.9 },
      {
        property: 'brand',
        raw: 'Audeze',
        method: 'jsonld',
        path: 'jsonld[1].brand',
        confidence: 0.9,
      },
      {
        property: 'gtins',
        raw: '819343015004',
        method: 'jsonld',
        path: 'jsonld[1].mpn',
        confidence: 0.8,
      },
      { property: 'name', raw: 'LCD-X', method: 'jsonld', path: 'jsonld[2].name', confidence: 0.9 },
      {
        property: 'brand',
        raw: 'Audeze',
        method: 'jsonld',
        path: 'jsonld[2].brand',
        confidence: 0.9,
      },
    ]);
  });

  it('reads GTINs and part numbers from the product, its offers, and its variants, skipping placeholders', () => {
    const candidates = productPack.extract(
      page(
        ld({
          '@type': 'ProductGroup',
          name: 'HD 600',
          brand: 'Sennheiser',
          hasVariant: [
            {
              '@type': 'Product',
              gtin13: '4006381333931',
              offers: { '@type': 'Offer', mpn: '508824' },
            },
            { '@type': 'Product', gtin: 4006381333931, mpn: 'N/A' },
          ],
        }),
      ),
    );
    expect(candidates.filter((c) => c.property === 'gtins' || c.property === 'mpns')).toEqual([
      {
        property: 'gtins',
        raw: '4006381333931',
        method: 'jsonld',
        path: 'jsonld[0].hasVariant[0].gtin13',
        confidence: 0.9,
      },
      {
        property: 'mpns',
        raw: '508824',
        method: 'jsonld',
        path: 'jsonld[0].hasVariant[0].offers[0].mpn',
        confidence: 0.9,
      },
      {
        property: 'gtins',
        raw: '4006381333931',
        method: 'jsonld',
        path: 'jsonld[0].hasVariant[1].gtin',
        confidence: 0.9,
      },
    ]);
  });

  it('reads identifiers from the product’s own offers, one by one', () => {
    const candidates = productPack.extract(
      page(
        ld({
          '@type': 'Product',
          name: 'LCD-X',
          offers: [
            { '@type': 'Offer', gtin12: '819343015004' },
            { '@type': 'Offer', mpn: 'LX-1' },
          ],
        }),
      ),
    );
    expect(candidates.filter((c) => c.property !== 'name')).toEqual([
      {
        property: 'gtins',
        raw: '819343015004',
        method: 'jsonld',
        path: 'jsonld[0].offers[0].gtin12',
        confidence: 0.9,
      },
      {
        property: 'mpns',
        raw: 'LX-1',
        method: 'jsonld',
        path: 'jsonld[0].offers[1].mpn',
        confidence: 0.9,
      },
    ]);
  });

  it('reads each GTIN property schema.org has', () => {
    const candidates = productPack.extract(
      page(
        ld({
          '@type': 'Product',
          name: 'HD 600',
          gtin: '4006381333931',
          gtin8: '96385074',
          gtin12: '819343015004',
          gtin13: '4006381333931',
          gtin14: '10819343015001',
        }),
      ),
    );
    expect(candidates.filter((c) => c.property === 'gtins').map((c) => [c.path, c.raw])).toEqual([
      ['jsonld[0].gtin', '4006381333931'],
      ['jsonld[0].gtin8', '96385074'],
      ['jsonld[0].gtin12', '819343015004'],
      ['jsonld[0].gtin13', '4006381333931'],
      ['jsonld[0].gtin14', '10819343015001'],
    ]);
  });

  it('skips what stores write where there is no part number, and keeps real ones that resemble it', () => {
    const partNumbers = (mpn: string) =>
      productPack
        .extract(page(ld({ '@type': 'Product', name: 'LCD-X', mpn })))
        .filter((c) => c.property === 'mpns')
        .map((c) => c.raw);
    const placeholders = [
      'n/a',
      'N.A.',
      'None',
      'NULL',
      'Unknown',
      'Does not apply',
      'Not applicable',
    ];
    for (const mpn of [...placeholders, '0', '000', '-', '--']) {
      expect(partNumbers(mpn), mpn).toEqual([]);
    }
    for (const mpn of ['NA-100', '0A1', 'None-1']) {
      expect(partNumbers(mpn), mpn).toEqual([mpn]);
    }
  });

  it('reads only the first product, and others with its name, not related products', () => {
    const candidates = productPack.extract(
      page(
        ld({ '@type': 'Product', name: 'LCD-X', mpn: 'LX-1' }) +
          ld({ '@type': 'Product', name: 'LCD-XC', mpn: 'XC-1' }),
      ),
    );
    expect(candidates.map((c) => c.raw)).toEqual(['LCD-X', 'LX-1']);
  });

  it('takes the first product that has a name, not a nameless one ahead of it', () => {
    // Review apps and themes add Product nodes of their own, and some have no name.
    const candidates = productPack.extract(
      page(
        ld({ '@type': 'Product', mpn: 'STUB-1' }) +
          ld({ '@type': 'Product', name: 'LCD-X', brand: 'Audeze', mpn: 'LX-1' }) +
          ld({ '@type': 'Product', name: 'LCD-XC', mpn: 'XC-1' }),
      ),
    );
    expect(candidates).toEqual([
      { property: 'name', raw: 'LCD-X', method: 'jsonld', path: 'jsonld[1].name', confidence: 0.9 },
      {
        property: 'brand',
        raw: 'Audeze',
        method: 'jsonld',
        path: 'jsonld[1].brand',
        confidence: 0.9,
      },
      { property: 'mpns', raw: 'LX-1', method: 'jsonld', path: 'jsonld[1].mpn', confidence: 0.9 },
    ]);
  });

  it('reads only the first of several products when none has a name', () => {
    const candidates = productPack.extract(
      page(ld({ '@type': 'Product', mpn: 'A-1' }) + ld({ '@type': 'Product', mpn: 'B-1' })),
    );
    expect(candidates.map((c) => c.raw)).toEqual(['A-1']);
  });

  it('reads og:title only on product pages, as weak evidence, and product:brand', () => {
    expect(
      productPack.extract(
        page(
          '<meta property="og:type" content="product">' +
            '<meta property="og:title" content="Sennheiser HD 650 Wired Open-Back Headphones">' +
            '<meta property="product:brand" content="Sennheiser">',
        ),
      ),
    ).toEqual([
      {
        property: 'name',
        raw: 'Sennheiser HD 650 Wired Open-Back Headphones',
        method: 'opengraph',
        path: 'og:title',
        confidence: 0.6,
      },
      {
        property: 'brand',
        raw: 'Sennheiser',
        method: 'opengraph',
        path: 'product:brand',
        confidence: 0.8,
      },
    ]);
    expect(
      productPack.extract(
        page(
          '<meta property="og:type" content="website"><meta property="og:title" content="Shop">',
        ),
      ),
    ).toEqual([]);
  });
});

describe('productPack.finish', () => {
  it('takes the brand off the front of names, and leaves a name that is only the brand', () => {
    const finish = productPack.finish ?? ((candidates: Candidate[]) => candidates);
    const result = finish([
      { property: 'brand', raw: 'Sennheiser', method: 'rule', path: 'fixed', confidence: 1 },
      {
        property: 'name',
        raw: 'Sennheiser HD 650',
        method: 'jsonld',
        path: 'jsonld[0].name',
        confidence: 0.9,
      },
      {
        property: 'name',
        raw: 'Sennheiser',
        method: 'opengraph',
        path: 'og:title',
        confidence: 0.6,
      },
      { property: 'name', raw: 'HD 650', method: 'rule', path: 'css:h1', confidence: 0.9 },
    ]);
    expect(result.filter((c) => c.property === 'name')).toEqual([
      {
        property: 'name',
        raw: 'HD 650',
        method: 'jsonld',
        path: 'jsonld[0].name (without the brand)',
        confidence: 0.9,
      },
      {
        property: 'name',
        raw: 'Sennheiser',
        method: 'opengraph',
        path: 'og:title',
        confidence: 0.6,
      },
      { property: 'name', raw: 'HD 650', method: 'rule', path: 'css:h1', confidence: 0.9 },
    ]);
  });
});

describe('looksLikeGtin', () => {
  it('takes 12 to 14 digits with a valid check digit for a GTIN', () => {
    expect(looksLikeGtin('819343015004')).toBe(true);
    expect(looksLikeGtin('4006381333931')).toBe(true);
    expect(looksLikeGtin('508825')).toBe(false);
    expect(looksLikeGtin('96385074')).toBe(false);
    expect(looksLikeGtin('819343015005')).toBe(false);
  });
});
