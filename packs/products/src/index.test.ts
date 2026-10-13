import { parsePage, type Candidate, type Page } from '@spatula/core';
import { describe, expect, it } from 'vitest';
import { looksLikeGtin, productPack, withoutProductType } from './index';

const page = (head: string) =>
  parsePage(`<html><head>${head}</head><body></body></html>`, 'https://maker.example/products/x');
const ld = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

const cpuMicroseconds = () => {
  const { user, system } = process.cpuUsage();
  return user + system;
};

/**
 * How many times as much each unit of work costs in `large` as in `small`, which does `times`
 * fewer units: about 1 for work that grows in step with its size. It counts this process's CPU
 * time, not time on the clock, because a busy machine stretches the clock for whatever it runs.
 * Each round runs `small` `times` over and `large` once, and the cheapest of three rounds of each
 * is what counts. @spatula/core's tests use the same check, which that package keeps to itself.
 */
const costRatio = (small: () => unknown, large: () => unknown, times: number): number => {
  small(); // V8 compiles the work before any round counts.
  let cheapestSmall = Infinity;
  let cheapestLarge = Infinity;
  for (let round = 0; round < 3; round += 1) {
    let started = cpuMicroseconds();
    for (let run = 0; run < times; run += 1) small();
    cheapestSmall = Math.min(cheapestSmall, cpuMicroseconds() - started);
    started = cpuMicroseconds();
    large();
    cheapestLarge = Math.min(cheapestLarge, cpuMicroseconds() - started);
  }
  return cheapestLarge / cheapestSmall;
};

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

  it('takes off the first brand given when two could start a name, in any case', () => {
    const finish = productPack.finish ?? ((candidates: Candidate[]) => candidates);
    const named = (brands: string[]) =>
      finish([
        ...brands.map(
          (raw): Candidate => ({
            property: 'brand',
            raw,
            method: 'jsonld',
            path: 'b',
            confidence: 1,
          }),
        ),
        {
          property: 'name',
          raw: 'Sennheiser Pro HD 650',
          method: 'jsonld',
          path: 'n',
          confidence: 1,
        },
      ]).find((c) => c.property === 'name')?.raw;
    expect(named(['Sennheiser', 'Sennheiser Pro'])).toBe('Pro HD 650');
    expect(named(['SENNHEISER PRO', 'Sennheiser'])).toBe('HD 650');
    expect(named(['', 'Pro'])).toBe('Sennheiser Pro HD 650');
  });
});

describe('productPack, on hostile pages', () => {
  const finish = productPack.finish ?? ((candidates: Candidate[]) => candidates);
  const read = (given: Page) => finish(productPack.extract(given));

  it('reads 20,000 products that share a name in linear time', { timeout: 60_000 }, () => {
    const sharing = (count: number) =>
      page(
        ld(
          Array.from({ length: count }, (_, i) => ({
            '@type': 'Product',
            name: 'LCD-X',
            brand: `Maker ${i}`,
          })),
        ),
      );
    const hostile = sharing(20_000);
    const candidates = read(hostile);
    expect(candidates).toHaveLength(40_000);
    expect(candidates.slice(0, 2)).toEqual([
      { property: 'name', raw: 'LCD-X', method: 'jsonld', path: 'jsonld[0].name', confidence: 0.9 },
      {
        property: 'brand',
        raw: 'Maker 0',
        method: 'jsonld',
        path: 'jsonld[0].brand',
        confidence: 0.9,
      },
    ]);
    expect(candidates.at(-2)).toMatchObject({ raw: 'LCD-X', path: 'jsonld[19999].name' });
    // Trying every brand on every name, and searching the page for each product's place, made each
    // product cost about 16 times as much among 10,000 as among a sixteenth of them. Looking both up
    // costs about the same per product at any size.
    const fewer = sharing(625);
    const more = sharing(10_000);
    expect(
      costRatio(
        () => read(fewer),
        () => read(more),
        16,
      ),
    ).toBeLessThan(4);
  });

  it('reads a 5 MB page of one product, repeated, in linear time', { timeout: 60_000 }, () => {
    // 160,000 products make about 5 MB, the most of a page the fetcher reads.
    const repeated = (count: number) =>
      page(ld(Array.from({ length: count }, () => ({ '@type': 'Product', name: 'X' }))));
    const largest = repeated(160_000);
    const candidates = read(largest);
    expect(candidates).toHaveLength(160_000);
    expect(candidates.at(-1)).toMatchObject({ raw: 'X', path: 'jsonld[159999].name' });
    // Searching the page for each product's place made each cost about 12 times as much here as on
    // a page a sixteenth the size. Finding every place in one pass costs about the same per product.
    const smaller = repeated(10_000);
    expect(
      costRatio(
        () => read(smaller),
        () => read(largest),
        16,
      ),
    ).toBeLessThan(4);
  });

  it('looks each name’s brand up once, however often it repeats', { timeout: 60_000 }, () => {
    // About 5 MB: 1,400 products share a name with a space at every other character, and each has
    // a brand of its own length, so every name could be checked against a slice of every length.
    const name = 'a '.repeat(1_400).trim();
    const crafted = (count: number) =>
      page(
        ld(
          Array.from({ length: count }, (_, i) => ({
            '@type': 'Product',
            name,
            brand: 'b'.repeat(i + 1),
          })),
        ),
      );
    const largest = crafted(1_400);
    const candidates = read(largest);
    expect(candidates.filter((c) => c.property === 'name' && c.raw === name)).toHaveLength(1_400);
    // Checking every name against every length made each product cost about 12 times as much here
    // as with an eighth of the products. Checking each name once costs about the same per product.
    const smaller = crafted(175);
    expect(
      costRatio(
        () => read(smaller),
        () => read(largest),
        8,
      ),
    ).toBeLessThan(4);
  });

  it('reads a brand nested 20,000 arrays deep', () => {
    const deep = `${'['.repeat(20_000)}"Audeze"${']'.repeat(20_000)}`;
    const hostile = page(
      `<script type="application/ld+json">{"@type":"Product","name":"LCD-X","brand":${deep}}</script>`,
    );
    expect(productPack.extract(hostile)).toContainEqual({
      property: 'brand',
      raw: 'Audeze',
      method: 'jsonld',
      path: 'jsonld[0].brand',
      confidence: 0.9,
    });
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

describe('withoutProductType', () => {
  it.each([
    ['LCD-5 Flagship Headphones', 'LCD-5'],
    ['CRBN2 Electrostatic Headphone', 'CRBN2'],
    ['HD 660S2 Open-Back Audiophile Headphones', 'HD 660S2'],
    ['K19 Desktop DAC & Amp', 'K19'],
    ['BLESSING3 2DD+4BA In-Ear Monitor', 'BLESSING3'],
    ['MOONRIVER2 USB DAC/AMP', 'MOONRIVER2'],
    ['Mojo 2 - Portable DAC/Amp', 'Mojo 2'],
    ['HDV 820 Headphone Amplifier', 'HDV 820'],
    ['Utopia Reference open-back hi-fi headphones', 'Utopia'],
    ['Bathys MG Wireless Headphones', 'Bathys MG'],
    ['Chu  II  IEMs and   earphones', 'Chu II'],
    // A comma or colon after the name needs no space before it.
    ['Mojo 2, Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2: Portable DAC/Amp', 'Mojo 2'],
    ['HD 600, Open-Back Headphones', 'HD 600'],
    // "for" says what a type is for: it doesn't make a list of types out of "Atom Amp".
    ['Atom Amp for Headphones', 'Atom Amp'],
    ['Atom DAC for IEMs', 'Atom DAC'],
    ['Anni Amplifier for Headphones', 'Anni'],
    // Descriptors and spellings makers use.
    ['DT 770 PRO 80 Ohm Closed-Back Studio Headphones', 'DT 770 PRO 80 Ohm'],
    ['Anni Desktop Integrated Amplifier', 'Anni'],
    ['X Active Noise Cancelling Headphones', 'X'],
    ['X Active Noise Canceling Headphones', 'X'],
    ['X Noise-Canceling Headphones', 'X'],
    ['X Cancelling Headphones', 'X'],
    ['BLESSING3 2DD+4BA In-Ear Monitors', 'BLESSING3'],
    ['Chu II Earphone', 'Chu II'],
    ['Chu II Earbud', 'Chu II'],
    ['Mojo 2 Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2 Portable DAC / Amp', 'Mojo 2'],
    ['Mojo 2 Portable DAC & Amp', 'Mojo 2'],
    ['Mojo 2 Portable Amp / DAC', 'Mojo 2'],
    ['Mojo 2 Portable Amp & DAC', 'Mojo 2'],
    // A joiner that the descriptors leave at the end comes off with them. When a type is before it,
    // that type goes the way it does in "Anni Amplifier for Headphones", and so does the type
    // before that one.
    ['Magni Heresy Headphone Amplifier for Open-Back Headphones', 'Magni Heresy'],
    ['Heresy Headphone Amplifier for Wired Headphones for Open-Back Earphones', 'Heresy'],
    ['Anni Amplifier, for Open-Back Headphones', 'Anni'],
    // "and", "&", "+", and "/" make a list, so a short type before them is a type.
    ['K19 Desktop DAC & Portable Amp', 'K19'],
    ['Mojo 2 DAC & Portable Amp', 'Mojo 2'],
    // "for" and "with" don't, so a short type before them is a name.
    ['Atom Amp for Open-Back Headphones', 'Atom Amp'],
    ['Zen DAC with Headphone Amplifier', 'Zen DAC'],
    // With no type before it, a joiner that only joined the name to its type goes alone.
    ['Mojo 2 & Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2 and Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2 + Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2 / Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2, and Portable DAC/Amp', 'Mojo 2'],
    ['Mojo 2 & - Portable DAC/Amp', 'Mojo 2'],
    // More descriptors, and the sizes of connectors and drivers. "PRO" is part of a name.
    ['MM-500 Professional Planar Magnetic Headphones', 'MM-500'],
    ['DT 990 PRO Open Studio Headphones', 'DT 990 PRO'],
    ['ARIA 2 Dynamic Driver In-Ear Earphones', 'ARIA 2'],
    ['Dawn Pro 3.5mm Headphone Amp', 'Dawn Pro'],
    ['Dawn Pro 4.4 mm Balanced Headphone Amp', 'Dawn Pro'],
    ['Dawn Pro 6.35MM Headphone Amp', 'Dawn Pro'],
    ['ARIA 2 40mm Dynamic Driver Earphones', 'ARIA 2'],
    // A size is a word of its own.
    ['Studio 3.5mmusb Headphones', 'Studio 3.5mmusb'],
  ])('takes the product type off %s', (name, expected) => {
    expect(withoutProductType(name)).toBe(expected);
  });

  it.each([
    'Atom Amp+',
    'Atom Amp 2',
    'Atom Amp',
    'Momentum 4 Wireless',
    'Clear MG Professional',
    'Stand for Headphones',
    'Headphones',
    'HD 800 S',
    // What would be left is only words that describe the type, or a separator.
    'Wireless Headphones',
    'Open-Back Headphones',
    '- Headphones',
    'Headphones Amplifier',
    '2DD+4BA In-Ear Monitor',
    // A bare abbreviation after a model stays, however it is spelled.
    'Mojo 2 DAC/Amp',
    'Mojo 2 DAC / Amp',
    'Mojo 2 DAC & Amp',
    'Mojo 2 Amp / DAC',
    'Mojo 2 Amp & DAC',
    // Something for a type, or with one, is not a type: its joiner stays with what it joins.
    'Stand for Open-Back Headphones',
    'Case with Planar Magnetic Headphones',
    // Sizes, spaced or not, and the types beside them, are no name.
    '3.5mm Headphones',
    '3.5 mm Headphones',
    '3.5mm Amp Headphones',
  ])('leaves %s as it is', (name) => {
    expect(withoutProductType(name)).toBeNull();
  });

  // A name is stripped in microseconds, so each measure strips it 500 times.
  const strippedRepeatedly = (name: string) => () => {
    for (let run = 0; run < 500; run += 1) withoutProductType(name);
  };

  it('reads a name made of separators in the time of any other name of its length', () => {
    // A regex that retried from every " -" took about 900 microseconds on the first of these, more
    // than 60 times what the second takes.
    const crafted = `a${' -'.repeat(490)} x Headphones`;
    const ordinary = `a${' b'.repeat(490)} x Headphones`;
    expect(withoutProductType(crafted)).toBe(`a${' -'.repeat(490)} x`);
    expect(costRatio(strippedRepeatedly(ordinary), strippedRepeatedly(crafted), 1)).toBeLessThan(4);
  });

  it('takes a run of separators off the end in the time of any other name of its length', () => {
    // The separators here are at the end, so each of them comes off, one at a time. A loop body
    // that read the whole name again for each one took about 200 times what the ordinary name
    // takes, and the test above never reached it: that name ends in a letter.
    const crafted = `a${' -'.repeat(400)} Headphones`;
    const ordinary = `a${' b'.repeat(400)} Headphones`;
    expect(crafted.length).toBe(ordinary.length);
    expect(withoutProductType(crafted)).toBe('a');
    expect(costRatio(strippedRepeatedly(ordinary), strippedRepeatedly(crafted), 1)).toBeLessThan(4);
  });

  // An ordinary name of the length given: a word, then single letters, then a type.
  const ordinaryName = (length: number) => {
    const pairs = Math.floor((length - 12) / 2);
    return `${'x'.repeat(length - 11 - 2 * pairs)}${' b'.repeat(pairs)} Headphones`;
  };

  // Each group below is a joiner, descriptors, and a type, which is a round of its own. The rounds
  // end with the sixteen types and the sixteen descriptors that a name may lose in all.
  it.each([
    {
      limit: 'types',
      group: ' for usb Headphones',
      groups: 50,
      // Sixteen groups come off whole.
      left: (group: string) => `x${group.repeat(34)}`,
    },
    {
      limit: 'descriptors',
      group: ' for usb usb Headphones',
      groups: 40,
      // Eight groups come off whole, and the ninth loses only its type.
      left: (group: string) => `x${group.repeat(31)} for usb usb`,
    },
  ])(
    'stops a chain at sixteen $limit, in the time of any other name',
    ({ group, groups, left }) => {
      const chain = `x${group.repeat(groups)}`;
      const ordinary = ordinaryName(chain.length);
      expect(ordinary.length).toBe(chain.length);
      expect(withoutProductType(chain)).toBe(left(group));
      expect(costRatio(strippedRepeatedly(ordinary), strippedRepeatedly(chain), 1)).toBeLessThan(4);
    },
  );
});

describe('productPack.finish, with product types', () => {
  const finish = productPack.finish ?? ((candidates: Candidate[]) => candidates);

  it('takes off the brand, then the product type, whatever the method', () => {
    const result = finish([
      { property: 'brand', raw: 'Audeze', method: 'rule', path: 'fixed', confidence: 1 },
      {
        property: 'name',
        raw: 'Audeze LCD-5 Flagship Headphones',
        method: 'jsonld',
        path: 'jsonld[1].name',
        confidence: 0.9,
      },
      {
        property: 'name',
        raw: 'MOONDROP BLESSING3 2DD+4BA In-Ear Monitor',
        method: 'rule',
        path: 'css:.bradcrumb-text',
        confidence: 0.9,
      },
    ]);
    expect(result.filter((candidate) => candidate.property === 'name')).toEqual([
      {
        property: 'name',
        raw: 'LCD-5',
        method: 'jsonld',
        path: 'jsonld[1].name (without the brand) (without the product type)',
        confidence: 0.9,
      },
      {
        property: 'name',
        raw: 'MOONDROP BLESSING3',
        method: 'rule',
        path: 'css:.bradcrumb-text (without the product type)',
        confidence: 0.9,
      },
    ]);
  });

  const audeze: Candidate = {
    property: 'brand',
    raw: 'Audeze',
    method: 'rule',
    path: 'fixed',
    confidence: 1,
  };
  const titled = (raw: string): Candidate => ({
    property: 'name',
    raw,
    method: 'opengraph',
    path: 'og:title',
    confidence: 0.6,
  });
  const nameCandidates = (candidates: Candidate[]) =>
    candidates.filter((candidate) => candidate.property === 'name');

  it.each(['-', '–', '—', '|', ':'])('takes a "%s" after the brand off with it', (separator) => {
    const result = finish([audeze, titled(`Audeze ${separator} LCD-5 Flagship Headphones`)]);
    expect(nameCandidates(result)).toEqual([
      { ...titled('LCD-5'), path: 'og:title (without the brand) (without the product type)' },
    ]);
  });

  it('leaves a hyphen that starts the model after the brand', () => {
    // "-5" has no space after its hyphen, so the hyphen is not a separator.
    expect(nameCandidates(finish([audeze, titled('Audeze -5 Flagship Headphones')]))).toEqual([
      { ...titled('-5'), path: 'og:title (without the brand) (without the product type)' },
    ]);
  });

  it('takes only the separator that leads the name', () => {
    expect(nameCandidates(finish([audeze, titled('Audeze LCD-5 - Planar')]))).toEqual([
      { ...titled('LCD-5 - Planar'), path: 'og:title (without the brand)' },
    ]);
  });

  it('leaves a name that is only the brand and a separator', () => {
    expect(nameCandidates(finish([audeze, titled('Audeze -')]))).toEqual([titled('Audeze -')]);
  });

  it('takes the brand and its separator off a name that is then only a type, and leaves the type', () => {
    // Taking the type off would leave nothing, so it stays: "Headphones" is no fragment of a name.
    expect(nameCandidates(finish([audeze, titled('Audeze - Headphones')]))).toEqual([
      { ...titled('Headphones'), path: 'og:title (without the brand)' },
    ]);
  });

  it('reads each name once, in time that grows with the page', { timeout: 60_000 }, () => {
    // A page that repeats its product repeats its name: each name here comes four times.
    const names = (count: number) =>
      Array.from(
        { length: count },
        (_, i): Candidate => ({
          property: 'name',
          raw: `C${Math.floor(i / 4)} ${'Flagship Open-Back '.repeat(20)}DAC & Amp & Headphones`,
          method: 'jsonld',
          path: `jsonld[${i}].name`,
          confidence: 0.9,
        }),
      );
    const small = names(100);
    const large = names(10_000);
    expect(
      costRatio(
        () => finish(small),
        () => finish(large),
        100,
      ),
    ).toBeLessThan(4);
    // A name far longer than any field keeps is left as it is, unread.
    const huge = `${'headphones '.repeat(100_000)}headphones`;
    expect(withoutProductType(huge)).toBeNull();
  });

  it('reads a name once however often a page repeats it', { timeout: 60_000 }, () => {
    // The same name 50,000 times, on two pages. The first name is 1,000 characters long and ends in
    // sixteen types and sixteen descriptors, which takes about fifteen microseconds to read. The
    // second is a character longer, more than a name is read at all, so reading it costs nothing.
    // Reading every repeat again would make the first page cost about seven times what the second
    // does.
    const types = `${'usb '.repeat(16)}${'Headphones & '.repeat(15)}Headphones`;
    const read = `${'x'.repeat(999 - types.length)} ${types}`;
    const unread = `x${read}`;
    expect([read.length, unread.length]).toEqual([1_000, 1_001]);
    const repeated = (raw: string) =>
      Array.from(
        { length: 50_000 },
        (_, i): Candidate => ({
          property: 'name',
          raw,
          method: 'jsonld',
          path: `jsonld[${i}].name`,
          confidence: 0.9,
        }),
      );
    const stripped = repeated(read);
    const refused = repeated(unread);
    expect(withoutProductType(read)).not.toBeNull();
    expect(finish(stripped).every((candidate) => candidate.raw !== read)).toBe(true);
    expect(finish(refused).every((candidate) => candidate.raw === unread)).toBe(true);
    expect(
      costRatio(
        () => finish(refused),
        () => finish(stripped),
        1,
      ),
    ).toBeLessThan(4);
  });
});
