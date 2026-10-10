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
  finish: withoutBrandInNames,
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
  const candidates: Candidate[] = [];
  for (const node of chosen) {
    const at = `jsonld[${page.jsonLd.indexOf(node)}]`;
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

/** "Sennheiser HD 650", on a page whose brand is Sennheiser, names the product "HD 650". */
function withoutBrandInNames(candidates: Candidate[]): Candidate[] {
  const brands = candidates.flatMap((candidate) =>
    candidate.property === 'brand' && typeof candidate.raw === 'string'
      ? [candidate.raw.trim()]
      : [],
  );
  return candidates.map((candidate) => {
    if (candidate.property !== 'name' || typeof candidate.raw !== 'string') return candidate;
    const name = candidate.raw.trim();
    const brand = brands.find(
      (b) => b !== '' && name.toLowerCase().startsWith(`${b.toLowerCase()} `),
    );
    const rest = brand === undefined ? '' : name.slice(brand.length + 1).trim();
    return rest === ''
      ? candidate
      : { ...candidate, raw: rest, path: `${candidate.path} (without the brand)` };
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
  if (Array.isArray(value)) return brandName(value[0]);
  if (value !== null && typeof value === 'object' && 'name' in value) return text(value.name);
  return text(value);
}

function isPlaceholder(value: string): boolean {
  const key = value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return key === '' || /^0+$/u.test(key) || NO_PART_NUMBER.has(key);
}
