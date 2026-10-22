import { describe, expect, it } from 'vitest';
import { addressError, decidedField, hasTaxonomy, parseDefinition } from './definition';
import { costRatio } from './testing/cost';

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
    expect(issuesOf(definition({ schedule: 'daily' }))).toEqual([
      expect.stringContaining('schedule'),
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

  // Names are looked up in plain objects, which already have these. They're refused before any
  // check can mistake an inherited function for a field or a record type.
  it.each([
    'constructor',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'toString',
    'valueOf',
  ])('reserves %s as a fixed field, and does not throw', (reserved) => {
    const bad = definition();
    bad.sources[0].fixed = { ...bad.sources[0].fixed, [reserved]: 'x' };
    expect(parseDefinition(bad)).toEqual({
      ok: false,
      issues: [`sources.0.fixed.${reserved}: That name is reserved. Pick another.`],
    });
  });

  it('reserves those names for record types and extracted fields too, and does not throw', () => {
    const type = definition();
    type.sources[0].recordType = 'toString';
    expect(parseDefinition(type)).toEqual({
      ok: false,
      issues: ['sources.0.recordType: That name is reserved. Pick another.'],
    });

    const extracted = definition();
    extracted.sources[0].extract = { ...extracted.sources[0].extract, toString: { css: 'h1' } };
    expect(parseDefinition(extracted)).toEqual({
      ok: false,
      issues: ['sources.0.extract.toString: That name is reserved. Pick another.'],
    });
  });

  it('says how to write a name, wherever a record has a key that is not one', () => {
    const say = 'Use a camelCase name, like officialUrl.';
    const bad = definition();
    bad.recordTypes.product.fields.Brand = { type: 'text' };
    bad.sources[0].fixed = { Brand: 'Maker' };
    bad.sources[0].extract = { 'full name': { css: 'h1' } };
    expect(issuesOf(bad)).toEqual([
      `recordTypes.product.fields.Brand: ${say}`,
      `sources.0.fixed.Brand: ${say}`,
      `sources.0.extract.full name: ${say}`,
    ]);

    // A record type with a bad name isn't read any further, so it gets a definition of its own.
    const type = definition();
    type.recordTypes = { Product: type.recordTypes.product };
    expect(issuesOf(type)).toEqual([`recordTypes.Product: ${say}`]);
  });

  it.each([
    ['neither css nor url', { selector: 'h1' }],
    ['a url that is not canonical', { url: 'self' }],
    ['both css and url', { css: 'h1', url: 'canonical' }],
  ])('says how to write a rule that has %s', (_case, rule) => {
    const bad = definition();
    bad.sources[0].extract = { name: rule };
    expect(issuesOf(bad)).toEqual([
      'sources.0.extract.name: Use { css: "<selector>" } with an optional attr, or { url: canonical }.',
    ]);
  });

  it('refuses addresses Spatula must never fetch, in pages and in the terms', () => {
    const bad = definition();
    bad.sources[0].pages = [
      'https://127.0.0.1/admin',
      'https://printer.local/',
      'https://user:secret@maker.example/',
    ];
    bad.sources[0].evidence = {
      ...EVIDENCE,
      terms: { ...EVIDENCE.terms, url: 'https://localhost/terms' },
    };
    const use = 'Use the site’s public https:// address.';
    expect(issuesOf(bad)).toEqual([
      `sources.0.pages.0: This address is an IP address, not a host name. ${use}`,
      `sources.0.pages.1: This address is a private-use name. ${use}`,
      `sources.0.pages.2: This address is carrying a user name or password. ${use}`,
      `sources.0.evidence.terms.url: This address is a local name. ${use}`,
    ]);
  });

  it('says only that an address does not parse, when it does not', () => {
    const bad = definition();
    bad.sources[0].pages = ['not an address'];
    expect(issuesOf(bad)).toEqual(['sources.0.pages.0: Use an https:// address.']);
  });

  it('accepts the public addresses the fixtures use', () => {
    const good = definition();
    good.sources[0].pages = [
      'https://maker-a.example/products/a1',
      'https://www.audeze.com/products/lcd-x',
    ];
    expect(parseDefinition(good).ok).toBe(true);
  });

  it('allows a text field a maxLength of up to 600', () => {
    const withMaxLength = (maxLength: number) => {
      const input = definition();
      input.recordTypes.product.fields.name.maxLength = maxLength;
      return input;
    };
    expect(parseDefinition(withMaxLength(600)).ok).toBe(true);
    expect(issuesOf(withMaxLength(601))).toEqual([
      'recordTypes.product.fields.name.maxLength: Use a maxLength of 600 or less.',
    ]);
  });
});

describe('addressError', () => {
  const reason = (address: string) => addressError(new URL(address));

  it.each([
    'https://maker-a.example/products/a1',
    'https://www.audeze.com/products/lcd-x',
    'https://store.example/',
    'https://maker.test/',
    'https://MAKER.Example:8443/x',
    'https://bücher.example/',
    'https://@maker.example/',
    // Names that only look like the reserved ones.
    'https://localhost.example/',
    'https://lan.example/',
    'https://example.local.com/',
    'https://home.arpa.example/',
    'https://1.2.3.4.example/',
  ])('accepts %s', (address) => {
    expect(reason(address)).toBeNull();
  });

  it.each([
    ['https://user:secret@maker.example/', 'carrying a user name or password'],
    ['https://user@maker.example/', 'carrying a user name or password'],
    ['https://:secret@maker.example/', 'carrying a user name or password'],
    ['https://127.0.0.1/', 'an IP address, not a host name'],
    ['https://10.0.0.5/admin', 'an IP address, not a host name'],
    ['https://169.254.169.254/latest/meta-data/', 'an IP address, not a host name'],
    // The URL parser writes these other forms of 127.0.0.1 as a dotted quad.
    ['https://2130706433/', 'an IP address, not a host name'],
    ['https://0x7f.1/', 'an IP address, not a host name'],
    ['https://[::1]/', 'an IP address, not a host name'],
    ['https://[::ffff:127.0.0.1]/', 'an IP address, not a host name'],
    ['https://localhost/', 'a local name'],
    ['https://LOCALHOST:8443/', 'a local name'],
    ['https://app.localhost/', 'a local name'],
    ['https://intranet/', 'a local name'],
    ['https://printer.local/', 'a private-use name'],
    ['https://wiki.internal/', 'a private-use name'],
    ['https://router.home.arpa/', 'a private-use name'],
    ['https://home.arpa/', 'a private-use name'],
    ['https://nas.lan/', 'a private-use name'],
    // A trailing dot names the same host, and the URL parser keeps it.
    ['https://localhost./', 'a local name'],
    ['https://intranet./', 'a local name'],
    ['https://printer.local./', 'a private-use name'],
    ['https://127.0.0.1./', 'an IP address, not a host name'],
  ])('refuses %s: it is %s', (address, why) => {
    expect(reason(address)).toBe(why);
  });

  it('reads a host with a long run of dots in linear time', { timeout: 30_000 }, () => {
    // One host with the dots inside it, and one with them at its end.
    const dotted = (count: number) => [
      new URL(`https://a${'.'.repeat(count)}b/`),
      new URL(`https://localhost${'.'.repeat(count)}/`),
    ];
    const reasons = (hosts: URL[]) => () => hosts.map((host) => addressError(host));
    const large = dotted(40_000);
    expect(reasons(large)()).toEqual([null, 'a local name']);
    // A pattern that took the dots off the end tried each dot as the start of the run, so each dot
    // cost about 16 times as much among 40,000 as among a sixteenth of them. A loop costs the same.
    expect(costRatio(reasons(dotted(2_500)), reasons(large), 16)).toBeLessThan(4);
  });
});

describe('enum values', () => {
  it('are at most 254, each at most 600 characters', () => {
    const base = definition();
    const withValues = (values: string[]) =>
      definition({
        recordTypes: {
          product: {
            ...base.recordTypes.product,
            fields: {
              ...base.recordTypes.product.fields,
              category: { type: 'enum', required: true, values },
            },
          },
        },
        // The source fixes the category, so it has to be one of the values.
        sources: [{ ...base.sources[0], fixed: { brand: 'Maker', category: values[0] } }],
      });
    const many = Array.from({ length: 255 }, (_, index) => `Kind ${index}`);
    expect(parseDefinition(withValues(many))).toMatchObject({
      ok: false,
      issues: ['recordTypes.product.fields.category.values: List at most 254 values.'],
    });
    expect(parseDefinition(withValues(['x'.repeat(601)]))).toMatchObject({
      ok: false,
      issues: [
        'recordTypes.product.fields.category.values.0: Use values of 600 characters or less.',
      ],
    });
    expect(parseDefinition(withValues(many.slice(0, 254))).ok).toBe(true);
  });
});

const sitemapSource = {
  id: 'maker-c',
  kind: 'sitemap',
  recordType: 'product',
  sitemaps: ['https://maker-c.example/sitemap.xml'],
  include: ['/products/*'],
  fixed: { brand: 'Maker C' },
  evidence: {
    robots: '2026-10-12',
    terms: {
      url: 'https://maker-c.example/terms',
      checked: '2026-10-12',
      automatedAccess: 'not-mentioned',
    },
  },
};

describe('sitemap sources', () => {
  it('read their pages from sitemaps, with defaults for what they leave out', () => {
    const base = definition();
    const parsed = parseDefinition(definition({ sources: [...base.sources, sitemapSource] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.sources[1]).toMatchObject({
      kind: 'sitemap',
      follow: [],
      exclude: [],
      maxPages: 1000,
      useLastmod: false,
      extract: {},
    });
  });

  it('need at least one include pattern, and patterns that start with /', () => {
    const parsed = parseDefinition(
      definition({ sources: [{ ...sitemapSource, include: [], exclude: ['products/*'] }] }),
    );
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      'sources.0.include: Too small: expected array to have >=1 items',
      'sources.0.exclude.0: Write a path pattern that starts with /, like /products/*.',
    ]);
  });

  it('take up to 100 exclude patterns, as a large store needs', () => {
    const excludes = (count: number) =>
      Array.from({ length: count }, (_, index) => `/products/*part-${index}*`);
    expect(
      parseDefinition(definition({ sources: [{ ...sitemapSource, exclude: excludes(100) }] })).ok,
    ).toBe(true);
    expect(
      issuesOf(definition({ sources: [{ ...sitemapSource, exclude: excludes(101) }] })),
    ).toEqual(['sources.0.exclude: Too big: expected array to have <=100 items']);
  });

  it('refuse a pattern with a lone surrogate, half a character that can’t be matched', () => {
    const message = 'A pattern is well-formed text, with no lone surrogate.';
    const patterns = (lists: Record<string, string[]>) =>
      definition({ sources: [{ ...sitemapSource, ...lists }] });
    // A high surrogate, a low one, and the two in the wrong order, one in each list of patterns.
    const lone = patterns({
      follow: ['/sitemap-\u{D800}'],
      include: ['/products/\u{DC00}*'],
      exclude: ['/products/\u{DC00}\u{D800}'],
    });
    expect(issuesOf(lone)).toEqual([
      `sources.0.follow.0: ${message}`,
      `sources.0.include.0: ${message}`,
      `sources.0.exclude.0: ${message}`,
    ]);
    // A pair of surrogates is a character, however it is written.
    const characters = ['/produkte/\u{1F600}', '/produkte/\u{D83D}\u{DE00}', '/produkte/\u{E4}*'];
    expect(parseDefinition(patterns({ include: characters })).ok).toBe(true);
  });

  it('refuse sitemaps at addresses Spatula must never fetch', () => {
    const parsed = parseDefinition(
      definition({
        sources: [{ ...sitemapSource, sitemaps: ['https://intranet.local/sitemap.xml'] }],
      }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      issues: [
        'sources.0.sitemaps.0: This address is a private-use name. Use the site’s public https:// address.',
      ],
    });
  });
});

describe('a decided field', () => {
  const withCategory = (category: Record<string, unknown>) => {
    const base = definition();
    return definition({
      recordTypes: {
        product: {
          ...base.recordTypes.product,
          fields: { ...base.recordTypes.product.fields, category },
        },
      },
    });
  };

  it('is a required enum that identifies nothing', () => {
    const parsed = parseDefinition(
      withCategory({ type: 'enum', required: true, values: ['Headphones'], decide: true }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(decidedField(parsed.definition.recordTypes.product!)?.[0]).toBe('category');
  });

  it('is refused anywhere else', () => {
    expect(
      parseDefinition(withCategory({ type: 'text', required: true, decide: true })),
    ).toMatchObject({
      ok: false,
      issues: ['recordTypes.product.fields.category.decide: Only enum fields can be decided.'],
    });
    expect(
      parseDefinition(withCategory({ type: 'enum', values: ['Headphones'], decide: true })),
    ).toMatchObject({
      ok: false,
      issues: [
        'recordTypes.product.fields.category.decide: A decided field must be required: “None of these” is how a page leaves the dataset.',
      ],
    });
  });

  it('is refused on a field that identifies the record', () => {
    const input = withCategory({
      type: 'enum',
      required: true,
      values: ['Headphones'],
      decide: true,
    });
    // The category is part of a key now: the brand, name, and category together name a record.
    input.recordTypes.product.identity.keys = [['brand', 'name', 'category']];
    expect(parseDefinition(input)).toMatchObject({
      ok: false,
      issues: [
        'recordTypes.product.fields.category.decide: Fields that identify a record come from structured data or declared rules, never a decision.',
      ],
    });
  });

  it('is refused on a second field of the record type', () => {
    const input = withCategory({
      type: 'enum',
      required: true,
      values: ['Headphones'],
      decide: true,
    });
    input.recordTypes.product.fields.connection = {
      type: 'enum',
      required: true,
      values: ['Wired', 'Wireless'],
      decide: true,
    };
    expect(parseDefinition(input)).toMatchObject({
      ok: false,
      issues: ['recordTypes.product.fields: Only one field of a record type can be decided.'],
    });
  });

  describe('has values that', () => {
    const issue =
      'recordTypes.product.fields.category.values: A decided field’s values are distinct regardless of case, and none is “None of these”.';
    const decided = (values: string[]) =>
      withCategory({ type: 'enum', required: true, values, decide: true });

    it('are distinct', () => {
      expect(parseDefinition(decided(['Headphones', 'DAC/Amp', 'Headphones']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
    });

    it('are distinct regardless of case', () => {
      // A decided answer is matched to a value without regard to case, so these would be one.
      expect(parseDefinition(decided(['Headphones', 'DAC/Amp', 'headphones']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
      expect(parseDefinition(decided(['Headphones', 'DAC/Amp', 'dac/AMP']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
    });

    it('leave out “None of these”, the answer that takes a page out of the dataset', () => {
      expect(parseDefinition(decided(['Headphones', 'None of these']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
      // One report for the field, however many ways its values are wrong.
      expect(
        parseDefinition(decided(['None of these', 'Headphones', 'None of these'])),
      ).toMatchObject({ ok: false, issues: [issue] });
    });

    it('leave out “None of these” in any case', () => {
      expect(parseDefinition(decided(['Headphones', 'none of these']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
      expect(parseDefinition(decided(['NONE OF THESE', 'Headphones']))).toMatchObject({
        ok: false,
        issues: [issue],
      });
    });

    it('may differ in more than case', () => {
      expect(parseDefinition(decided(['Headphones', 'Headphone', 'None of these items'])).ok).toBe(
        true,
      );
    });

    it('are not checked on a field that is not decided', () => {
      // Only a decided field's question adds an answer of its own to the values.
      const input = withCategory({
        type: 'enum',
        required: true,
        values: ['Headphones', 'None of these', 'Headphones', 'headphones', 'none of these'],
      });
      expect(parseDefinition(input).ok).toBe(true);
    });
  });
});

describe('dataset settings', () => {
  it('default to a week’s freshness, the 5%-or-25 removal guard, balanced approval, and no consumers', () => {
    // Slice 0's definitions carry none of these keys.
    const parsed = parseDefinition(definition());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition).toMatchObject({
      freshness: { maxAgeDays: 7 },
      gates: { maxRemovals: { count: 25, share: 0.05 } },
      publication: { approval: 'balanced' },
      decisions: { classify: { accept: 0.9 }, match: { accept: 0.95 } },
      budget: { itemsPerRun: 1000, llmTokensPerRun: 2_000_000 },
      consumers: [],
    });
  });

  it('hand every parse its own objects for the defaults it fills in', () => {
    // zod copies only a default's outer object, so a default holding an object or an array would
    // give every parse the same one, and a Worker isolate parses for many requests.
    const bare = () => {
      const input = definition();
      delete input.policy;
      return input;
    };
    const first = parseDefinition(bare());
    const second = parseDefinition(bare());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.definition).toEqual(first.definition);
    expect(second.definition.gates.maxRemovals).not.toBe(first.definition.gates.maxRemovals);
    expect(second.definition.decisions.classify).not.toBe(first.definition.decisions.classify);
    expect(second.definition.decisions.match).not.toBe(first.definition.decisions.match);
    expect(second.definition.policy.purposes).not.toBe(first.definition.policy.purposes);
  });

  it('name consumers by slug', () => {
    const parsed = parseDefinition(definition({ consumers: ['crowdio', 'Not A Slug'] }));
    expect(parsed).toMatchObject({
      ok: false,
      issues: ['consumers.1: Use lowercase letters, digits, and hyphens, up to 63 characters.'],
    });
  });
});

describe('a record type with a taxonomy', () => {
  const SCOPE = 'Hi-fi made for audio. Out of scope: accessories.';

  /** A copy of the object without one key; the lint rules don't let a destructured key go unused. */
  function without(object: Record<string, unknown>, omitted: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(object).filter(([key]) => key !== omitted));
  }

  /** The fixture with its category enum replaced by the taxonomy's decided fields. */
  function withTaxonomy(overrides: Record<string, unknown> = {}): any {
    const base = definition();
    const fields = without(base.recordTypes.product.fields, 'category');
    return {
      ...base,
      scope: SCOPE,
      recordTypes: { product: { ...base.recordTypes.product, taxonomy: { decide: true }, fields } },
      sources: [{ ...base.sources[0], fixed: { brand: 'Maker' } }],
      ...overrides,
    };
  }

  it('reads the scope and the taxonomy', () => {
    const result = parseDefinition(withTaxonomy());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.scope).toBe(SCOPE);
    expect(result.definition.recordTypes.product?.taxonomy).toEqual({ decide: true });
    expect(hasTaxonomy(result.definition.recordTypes.product!)).toBe(true);
  });

  it('keeps a decided enum working as before, with no scope', () => {
    const base = definition();
    base.recordTypes.product.fields.category.decide = true;
    base.sources[0].fixed = { brand: 'Maker' };
    const result = parseDefinition(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hasTaxonomy(result.definition.recordTypes.product!)).toBe(false);
    expect(result.definition.scope).toBeUndefined();
    expect(result.definition.recordTypes.product).not.toHaveProperty('taxonomy');
  });

  it('takes a taxonomy or a decided field, never both, and reserves the taxonomy’s names', () => {
    const both = withTaxonomy();
    both.recordTypes.product.fields.kind = {
      type: 'enum',
      required: true,
      decide: true,
      values: ['A', 'B'],
    };
    expect(issuesOf(both)).toContain(
      'recordTypes.product.taxonomy: A record type has a decided field or a taxonomy, never both.',
    );
    const named = withTaxonomy();
    named.recordTypes.product.fields.category = { type: 'enum', required: true, values: ['A'] };
    expect(issuesOf(named)).toContain(
      'recordTypes.product.fields.category: A record type with a taxonomy gets shelf, functions, and features from it, and category for one release, so it can’t declare category.',
    );
  });

  it('wants the scope a taxonomy keeps to', () => {
    const unscoped = without(withTaxonomy(), 'scope');
    expect(issuesOf(unscoped)).toContain(
      'scope: A dataset with a taxonomy states its scope: what is in, and what is out.',
    );
  });

  it('lets a source fix or extract the shelf only when the record type has a taxonomy', () => {
    const fixed = withTaxonomy();
    fixed.sources[0].fixed.shelf = 'power-amps';
    expect(issuesOf(fixed)).toEqual([]);
    const extracted = withTaxonomy();
    extracted.sources[0].extract.shelf = { css: '.breadcrumb li:last-child' };
    expect(issuesOf(extracted)).toEqual([]);
    const both = withTaxonomy();
    both.sources[0].fixed.shelf = 'power-amps';
    both.sources[0].extract.shelf = { css: 'h2' };
    expect(issuesOf(both)).toContain(
      'sources.0.extract.shelf: shelf is fixed, so it can’t also be extracted.',
    );
    const address = withTaxonomy();
    address.sources[0].extract.shelf = { url: 'canonical' };
    expect(issuesOf(address)).toContain(
      'sources.0.extract.shelf: A shelf comes from a selector’s text, not the page address.',
    );
    const blank = withTaxonomy();
    blank.sources[0].fixed.shelf = '  ';
    expect(issuesOf(blank)).toContain(
      'sources.0.fixed.shelf: Fix the shelf by its slug or its name.',
    );
    const enumOnly = definition();
    enumOnly.sources[0].fixed.shelf = 'power-amps';
    expect(issuesOf(enumOnly)).toContain('sources.0.fixed.shelf: There’s no field called shelf.');
  });
});
