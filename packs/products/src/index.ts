import {
  jsonLdTypes,
  normalizeGtin,
  type Candidate,
  type JsonLdNode,
  type PackRegistry,
  type Page,
  type RecordTypePack,
} from '@spatula/core';

/*
 * Products, as schema.org JSON-LD and OpenGraph describe them. A value the page's structured data
 * states outright is trusted more than its title, which sites pad with marketing words. Stores
 * often put a product's barcode in `mpn`, so a "part number" that is really a GTIN is read as one.
 */

const JSONLD = 0.9;
const GTIN_IN_MPN = 0.8;
const OG_BRAND = 0.8;
const OG_TITLE = 0.6;
const GTIN_KEYS = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'] as const;
/** What stores write where a product has no part number, compared by letters and digits. */
const NO_PART_NUMBER = new Set(['na', 'none', 'null', 'unknown', 'doesnotapply', 'notapplicable']);

export const productPack: RecordTypePack = {
  fields: {
    brand: { type: 'text', list: false },
    name: { type: 'text', list: false },
    gtins: { type: 'gtin', list: true },
    mpns: { type: 'text', list: true },
  },
  extract: (page) => [...fromJsonLd(page), ...fromOpenGraph(page)],
  finish: (candidates) => withoutProductTypes(withoutBrandInNames(candidates)),
  match: {
    version: 1,
    criteria: [
      'same: the same model. Colors, finishes, and bundles of the same model are the same product.',
      'variant: a version of the model whose specifications differ, such as another impedance, a Pro or Mk II version, a newer generation, or wired against wireless.',
      'different: different models.',
      'Identifiers decide when both records have them: different GTINs or part numbers for one brand mean a variant or a different product.',
    ].join('\n'),
  },
};

/** The packs this package provides, by the name definitions use. */
export const packs: PackRegistry = { 'products/product': productPack };

/** 12 to 14 digits with a valid check digit: a UPC, EAN, or GTIN-14, wherever a store wrote it. */
export function looksLikeGtin(value: string): boolean {
  const digits = value.replace(/[\s-]/gu, '');
  return /^\d{12,14}$/u.test(digits) && normalizeGtin(digits) !== null;
}

function fromJsonLd(page: Page): Candidate[] {
  const products = page.jsonLd.filter((node) =>
    jsonLdTypes(node).some((type) => type === 'Product' || type === 'ProductGroup'),
  );
  // A page can describe related products too. Only the first product counts, with any others
  // that share its name (themes and review apps often repeat the same product). A node without a
  // name can't share one, so the first node that has a name counts, and if none does, only the
  // first node is read.
  const first = products.find((node) => text(node.name) !== null) ?? products[0];
  if (first === undefined) return [];
  const firstName = text(first.name)?.toLowerCase();
  const chosen = products.filter(
    (node) =>
      node === first || (firstName !== undefined && text(node.name)?.toLowerCase() === firstName),
  );
  // Each node's place on the page, found once. Searching the page for each chosen node would take
  // time that grows with the square of a page that repeats its product thousands of times.
  const places = new Map<JsonLdNode, number>();
  page.jsonLd.forEach((node, index) => {
    if (!places.has(node)) places.set(node, index);
  });
  const candidates: Candidate[] = [];
  for (const node of chosen) {
    const at = `jsonld[${places.get(node)}]`;
    const name = text(node.name);
    if (name !== null) candidates.push(found('name', name, `${at}.name`, JSONLD));
    const brand = brandName(node.brand);
    if (brand !== null) candidates.push(found('brand', brand, `${at}.brand`, JSONLD));
    for (const [path, holder] of identifierHolders(node, at))
      candidates.push(...identifiers(holder, path));
  }
  return candidates;
}

function fromOpenGraph(page: Page): Candidate[] {
  const candidates: Candidate[] = [];
  const type = page.meta.get('og:type')?.[0]?.toLowerCase() ?? '';
  const title = page.meta.get('og:title')?.[0];
  if (type.startsWith('product') && title) {
    candidates.push({
      property: 'name',
      raw: title,
      method: 'opengraph',
      path: 'og:title',
      confidence: OG_TITLE,
    });
  }
  const brand = page.meta.get('product:brand')?.[0];
  if (brand) {
    candidates.push({
      property: 'brand',
      raw: brand,
      method: 'opengraph',
      path: 'product:brand',
      confidence: OG_BRAND,
    });
  }
  return candidates;
}

/**
 * A dash, bar, or colon left leading a name once its brand is off: "Audeze - LCD-5". It counts with
 * a space after it, because a hyphen can start a model's name ("-5"), or with nothing after it, so
 * that "Audeze -" is still only a brand.
 */
const LEADING_SEPARATOR = /^[-–—|:](?:\s+|$)/u;

/**
 * "Sennheiser HD 650", on a page whose brand is Sennheiser, names the product "HD 650". A separator
 * after the brand goes with it: "Audeze - LCD-5" is "LCD-5".
 */
function withoutBrandInNames(candidates: Candidate[]): Candidate[] {
  // Each brand once, by its lowercase form, with the order it was first given in: when two brands
  // could start a name, the first one given is taken off.
  const brands = new Map<string, { brand: string; order: number }>();
  for (const candidate of candidates) {
    if (candidate.property !== 'brand' || typeof candidate.raw !== 'string') continue;
    const brand = candidate.raw.trim();
    const key = brand.toLowerCase();
    if (brand !== '' && !brands.has(key)) brands.set(key, { brand, order: brands.size });
  }
  const lengths = [...new Set([...brands.keys()].map((key) => key.length))];
  // A brand starts a name when the name's first characters are the brand, then a space.
  const startingBrand = (lower: string): string | null => {
    let first: { brand: string; order: number } | undefined;
    for (const length of lengths) {
      const brand = lower[length] === ' ' ? brands.get(lower.slice(0, length)) : undefined;
      if (brand !== undefined && (first === undefined || brand.order < first.order)) first = brand;
    }
    return first?.brand ?? null;
  };
  // A name's brand is looked up by length, not searched for among every brand, and once for each
  // name: a page that repeats its product repeats its name. So a page that repeats it thousands of
  // times, each with a brand of its own, costs time in proportion to its length, not its square.
  const brandOf = new Map<string, string | null>();
  return candidates.map((candidate) => {
    if (candidate.property !== 'name' || typeof candidate.raw !== 'string') return candidate;
    const name = candidate.raw.trim();
    const lower = name.toLowerCase();
    let brand = brandOf.get(lower);
    if (brand === undefined) {
      brand = startingBrand(lower);
      brandOf.set(lower, brand);
    }
    const afterBrand = brand === null ? '' : name.slice(brand.length + 1).trim();
    const rest = afterBrand.replace(LEADING_SEPARATOR, '');
    return rest === ''
      ? candidate
      : { ...candidate, raw: rest, path: `${candidate.path} (without the brand)` };
  });
}

/**
 * Product types that end a name on their own: "LCD-5 Flagship Headphones". Longest first, so the
 * longest a name ends with is the one taken.
 */
const WORD_TYPES = [
  'headphones amplifier',
  'headphone amplifier',
  'in-ear monitors',
  'in-ear monitor',
  'headphone amp',
  'preamplifier',
  'headphones',
  'headphone',
  'amplifier',
  'earphones',
  'earphone',
  'headsets',
  'headset',
  'earbuds',
  'earbud',
];

/**
 * Abbreviations that are types only beside other descriptors: "K19 Desktop DAC & Amp" loses them,
 * but "Atom Amp" is a name. "DAC/Amp", "DAC / Amp", and "DAC & Amp" are one type, so a bare one
 * after a model stays whichever way it is written.
 */
const SHORT_TYPES = [
  'dac/amplifier',
  'dac & amp',
  'dac / amp',
  'amp & dac',
  'amp / dac',
  'dac/amp',
  'amp/dac',
  'preamp',
  'iems',
  'iem',
  'dac',
  'amp',
];

/**
 * Words that join a type to what comes before it: "IEMs and earphones", "Headphones & Amplifier",
 * "Amplifier for Headphones", "DAC with Headphone Amp".
 */
const JOINERS = ['and', 'for', 'with', '&', '/', '+'];

/**
 * The joiners that say what a type is for, or has, instead of listing another: "Atom Amp for
 * Headphones" is an Amp, so its Amp isn't a type, and "Stand for Headphones" is a stand.
 */
const PREPOSITIONS = ['for', 'with'];

/** Descriptors taken off with a type, never on their own: "Momentum 4 Wireless" keeps its name. */
const DESCRIPTORS = [
  'noise-cancelling',
  'noise cancelling',
  'noise-canceling',
  'fully balanced',
  'true wireless',
  'electrostatic',
  'professional',
  'closed-back',
  'closed back',
  'cancelling',
  'integrated',
  'audiophile',
  'open-back',
  'open back',
  'bluetooth',
  'canceling',
  'reference',
  'flagship',
  'magnetic',
  'portable',
  'balanced',
  'wireless',
  'over-ear',
  'desktop',
  'dynamic',
  'digital',
  'on-ear',
  'in-ear',
  'gaming',
  'hi-res',
  'hybrid',
  'planar',
  'analog',
  'studio',
  'active',
  'driver',
  'hi-fi',
  'wired',
  'noise',
  'open',
  'usb',
];

/** Every phrase and mark that can only be a fragment of a name, longest first. */
const GENERIC = [
  ...WORD_TYPES,
  ...SHORT_TYPES,
  ...DESCRIPTORS,
  ...JOINERS,
  '-',
  '–',
  '—',
  '|',
  ':',
  ',',
].sort((a, b) => b.length - a.length);

/** Drivers, as IEM makers write them: "2DD+4BA", "1DD", "10BA". */
const DRIVERS = /^\d+(?:dd|ba|est|pzt|pd)(?:\+\d+(?:dd|ba|est|pzt|pd))*$/iu;

/**
 * A size in millimetres, as makers give a connector's or a driver's: "3.5mm", "4.4 mm", "40mm". The
 * patterns read one from where a word starts: to the end of the name, or to the end of a word.
 */
const SIZE = String.raw`\d+(?:\.\d+)? ?mm`;
const SIZE_TO_END = new RegExp(`${SIZE}$`, 'iuy');
const SIZE_TO_SPACE = new RegExp(`${SIZE}(?= |$)`, 'iuy');

/** A name longer than this is longer than any field keeps, so it's left for the field to refuse. */
const NAME_READ_MAX = 1000;
/** No real name ends in more types and descriptors than this. */
const MAX_TAKEN = 16;

/** The phrase from `phrases` that ends `text` after a space, ignoring case, or undefined. */
function endingIn(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find(
    (phrase) =>
      text.length > phrase.length &&
      text[text.length - phrase.length - 1] === ' ' &&
      text.slice(-phrase.length).toLowerCase() === phrase,
  );
}

function cut(text: string, phrase: string): string {
  return text.slice(0, text.length - phrase.length).trimEnd();
}

/** The type that ends `text` after a space, or undefined. */
function typeEnding(text: string): string | undefined {
  return endingIn(text, WORD_TYPES) ?? endingIn(text, SHORT_TYPES);
}

/** The size in millimetres that ends `text`, as it is written, or undefined. */
function endingInSize(text: string): string | undefined {
  // A size is the last word, "3.5mm", or the last two, "3.5 mm". It can be all of `text`.
  const last = text.lastIndexOf(' ') + 1;
  const previous = text.lastIndexOf(' ', last - 2) + 1;
  for (const start of [previous, last]) {
    SIZE_TO_END.lastIndex = start;
    if (SIZE_TO_END.test(text)) return text.slice(start);
  }
  return undefined;
}

/** Whether the word before a short type makes it one: another type, a descriptor, or a joiner. */
function describes(text: string): boolean {
  return (
    typeEnding(text) !== undefined ||
    endingIn(text, DESCRIPTORS) !== undefined ||
    endingIn(text, JOINERS) !== undefined
  );
}

/**
 * Whether `text` is nothing but types, descriptors, sizes, drivers, joiners, and separators, as
 * "Wireless" is, once the type is off "Wireless Headphones". Up to MAX_TAKEN of them make a
 * fragment, the most a name can lose. More are taken for a name.
 */
function onlyGeneric(text: string): boolean {
  const lower = text.toLowerCase();
  let at = 0;
  // One round more than MAX_TAKEN, to see that a text of exactly that many has ended.
  for (let words = 0; words <= MAX_TAKEN; words += 1) {
    while (lower[at] === ' ') at += 1;
    if (at >= lower.length) return true;
    // The longest phrase that starts here and ends at a word.
    const phrase = GENERIC.find(
      (candidate) =>
        lower.startsWith(candidate, at) &&
        (at + candidate.length === lower.length || lower[at + candidate.length] === ' '),
    );
    if (phrase !== undefined) {
      at += phrase.length;
      continue;
    }
    SIZE_TO_SPACE.lastIndex = at;
    const size = SIZE_TO_SPACE.exec(lower)?.[0];
    if (size !== undefined) {
      at += size.length;
      continue;
    }
    const space = lower.indexOf(' ', at);
    const word = lower.slice(at, space === -1 ? lower.length : space);
    if (!DRIVERS.test(word)) return false;
    at += word.length;
  }
  return false;
}

/**
 * The separators at the end of `text`, taken off one at a time, as in "Mojo 2 - Portable DAC/Amp"
 * or "Mojo 2, Portable DAC/Amp" once the type is off. A dash or bar counts only with a space
 * before it, because a hyphen can belong to a model's name ("LCD-X"); a comma or colon never ends
 * one. They go one at a time from the end: a pattern over a run of them retries from each, which
 * took 900 microseconds on a name of 990 characters.
 */
function withoutTrailingSeparators(text: string): string {
  let rest = text;
  while (/ [-–—|]$|[:,]$/u.test(rest.slice(-2))) rest = rest.slice(0, -1).trimEnd();
  return rest;
}

/** Whether a joiner makes a list of types: "and" does, and "for" and "with" don't. */
function makesList(joiner: string): boolean {
  return !PREPOSITIONS.includes(joiner);
}

/**
 * A name without the product type it ends with, and the descriptors just before it: "LCD-5
 * Flagship Headphones" is "LCD-5". Returns null when nothing comes off, including when taking the
 * type off would leave the name empty or only words that describe a type ("Wireless Headphones"
 * is not "Wireless"), or would leave a joiner with no type before it ("Stand for Headphones" is a
 * stand). Descriptors between the joiner and the type don't change that for "for" and "with"
 * ("Stand for Open-Back Headphones" is a stand), but "and", "&", "+", and "/" then only joined the
 * name to its type: "Mojo 2 & Portable DAC/Amp" is "Mojo 2".
 */
export function withoutProductType(name: string): string | null {
  if (name.length > NAME_READ_MAX) return null;
  const original = name.replace(/\s+/gu, ' ').trim();
  let rest = original;
  // The types and the descriptors taken over every round, each limited to MAX_TAKEN.
  let taken = 0;
  let described = 0;
  // Whether the type now at the end is joined to one already taken, as "IEMs" is in "IEMs and
  // earphones": a short type in a list of types is a type.
  let joined = false;
  // A round takes the types at the end, then the descriptors before them. A joiner they leave at
  // the end comes off too, and when a type is before it, another round takes that type, as it does
  // from "Anni Amplifier for Headphones": "Amplifier for Open-Back Headphones" is the same. A round
  // after the first takes a type or is the last, and types are taken MAX_TAKEN at most.
  let again: boolean;
  do {
    again = false;
    for (; taken < MAX_TAKEN; taken += 1) {
      const type = typeEnding(rest);
      if (type === undefined) break;
      const before = cut(rest, type);
      if (before === '') break;
      if (!joined && SHORT_TYPES.includes(type) && !describes(before)) break;
      rest = before;
      joined = false;
      const joiner = endingIn(rest, JOINERS);
      if (joiner !== undefined) {
        rest = cut(rest, joiner);
        // A joiner with no type before it means the words weren't a list of types.
        if (typeEnding(rest) === undefined) return null;
        // "and", "&", "+", and "/" make a list, so a short type before them is a type. "for" and
        // "with" don't: "Atom Amp for Headphones" is an Amp, for headphones.
        joined = makesList(joiner);
      }
    }
    if (taken === 0) return null;
    for (; described < MAX_TAKEN; described += 1) {
      const last = rest.slice(rest.lastIndexOf(' ') + 1);
      const drivers = rest.includes(' ') && DRIVERS.test(last) ? last : undefined;
      const word = endingIn(rest, DESCRIPTORS) ?? drivers ?? endingInSize(rest);
      // Nothing comes off that would leave the name empty: a size alone is left to `onlyGeneric`.
      if (word === undefined || cut(rest, word) === '') break;
      rest = cut(rest, word);
    }
    rest = withoutTrailingSeparators(rest);
    const joiner = endingIn(rest, JOINERS);
    if (joiner !== undefined) {
      rest = withoutTrailingSeparators(cut(rest, joiner));
      if (typeEnding(rest) !== undefined) {
        joined = makesList(joiner);
        again = true;
      } else if (!makesList(joiner)) {
        // The name is for a type or comes with one: "Stand for Open-Back Headphones".
        return null;
      }
      // Any other joiner only joined the name to its type: "Mojo 2 & Portable DAC/Amp" is "Mojo 2".
    }
  } while (again);
  return rest === '' || rest === original || onlyGeneric(rest) ? null : rest;
}

/** Each name without its product type, read once however often a page repeats it. */
function withoutProductTypes(candidates: Candidate[]): Candidate[] {
  const read = new Map<string, string | null>();
  return candidates.map((candidate) => {
    if (candidate.property !== 'name' || typeof candidate.raw !== 'string') return candidate;
    let stripped = read.get(candidate.raw);
    if (stripped === undefined) {
      stripped = withoutProductType(candidate.raw);
      read.set(candidate.raw, stripped);
    }
    return stripped === null
      ? candidate
      : { ...candidate, raw: stripped, path: `${candidate.path} (without the product type)` };
  });
}

/** The product, its offers, its variants, and their offers: everywhere identifiers appear. */
function identifierHolders(node: JsonLdNode, at: string): [string, JsonLdNode][] {
  const holders: [string, JsonLdNode][] = [[at, node]];
  objects(node.offers).forEach((offer, i) => holders.push([`${at}.offers[${i}]`, offer]));
  objects(node.hasVariant).forEach((variant, i) => {
    holders.push([`${at}.hasVariant[${i}]`, variant]);
    objects(variant.offers).forEach((offer, j) =>
      holders.push([`${at}.hasVariant[${i}].offers[${j}]`, offer]),
    );
  });
  return holders;
}

function identifiers(holder: JsonLdNode, at: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const key of GTIN_KEYS) {
    const gtin = scalar(holder[key]);
    if (gtin !== null) candidates.push(found('gtins', gtin, `${at}.${key}`, JSONLD));
  }
  const mpn = scalar(holder.mpn);
  if (mpn !== null && looksLikeGtin(mpn))
    candidates.push(found('gtins', mpn, `${at}.mpn`, GTIN_IN_MPN));
  else if (mpn !== null && !isPlaceholder(mpn))
    candidates.push(found('mpns', mpn, `${at}.mpn`, JSONLD));
  return candidates;
}

function found(property: string, raw: string, path: string, confidence: number): Candidate {
  return { property, raw, method: 'jsonld', path, confidence };
}

function objects(value: unknown): JsonLdNode[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is JsonLdNode => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function scalar(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
}

function brandName(value: unknown): string | null {
  // The first of a list, however deep lists nest. A loop, not recursion: a page can nest its brand
  // thousands of lists deep.
  while (Array.isArray(value)) value = value[0];
  if (value !== null && typeof value === 'object' && 'name' in value) return text(value.name);
  return text(value);
}

function isPlaceholder(value: string): boolean {
  const key = value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return key === '' || /^0+$/u.test(key) || NO_PART_NUMBER.has(key);
}
