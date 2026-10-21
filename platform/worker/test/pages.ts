/*
 * The test definition's three pages, as small as they can be while still being like the real ones.
 * A1's JSON-LD puts its UPC in `mpn`, as Audeze's pages do. A2's has a GTIN and a part number.
 * B1 has no structured data, so its source declares where the name is. Every page carries a token
 * in its head that changes on every fetch, as Shopify's do, while its text stays the same.
 */

import type { DecisionRequest } from '@spatula/core';

const page = (head: string, main: string) =>
  `<!doctype html><html><head>${head}</head><body><header><nav>Shop</nav></header><main>${main}</main><footer>Maker</footer></body></html>`;

const jsonLd = (data: object) =>
  `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data })}</script>`;

export const ROBOTS_OPEN = 'User-agent: *\nAllow: /\n';

export const A1 = (token = 'one') =>
  page(
    `<title>A1 | Maker A</title><meta name="csrf-token" content="${token}">` +
      '<link rel="canonical" href="https://maker-a.example/products/a1">' +
      jsonLd({
        '@type': 'Product',
        name: 'A1',
        brand: { '@type': 'Brand', name: 'Maker A' },
        mpn: '036000291452',
        sku: 'A1-BLK',
      }),
    '<h1>A1</h1><p>Impedance: 300 Ω</p><p>Weight: 350 g</p>',
  );

export const A2 = (token = 'one') =>
  page(
    `<title>A2 | Maker A</title><meta name="csrf-token" content="${token}">` +
      '<link rel="canonical" href="https://maker-a.example/products/a2">' +
      jsonLd({ '@type': 'Product', name: 'A2', gtin13: '4006381333931', mpn: 'A2-100' }),
    '<h1>A2</h1><p>Impedance: 32 Ω</p>',
  );

export const B1 = (heading = '<h1>B1 Amp</h1>') =>
  page(
    '<title>B1 Amp</title><meta property="og:type" content="product">' +
      '<meta property="og:title" content="Maker B B1 Desktop Amplifier for Headphones">' +
      '<link rel="canonical" href="https://maker-b.example/products/b1">',
    `${heading}<p>Output power: 1 W</p>`,
  );

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** A body that isn't text, such as a gzipped sitemap; it wins over body. */
  bytes?: Uint8Array;
  /** The fetcher stopped at its size cap, so the body is all it read. */
  truncated?: boolean;
}

export const URLS = {
  a1: 'https://maker-a.example/products/a1',
  a2: 'https://maker-a.example/products/a2',
  b1: 'https://maker-b.example/products/b1',
} as const;

/** Every page answering as it should, with open robots.txt files. */
export const standardRoutes = (): Record<string, Reply> => ({
  'https://maker-a.example/robots.txt': {
    status: 200,
    body: ROBOTS_OPEN,
    headers: { 'content-type': 'text/plain' },
  },
  'https://maker-b.example/robots.txt': {
    status: 200,
    body: 'User-agent: *\nDisallow: /cart\n',
    headers: { 'content-type': 'text/plain' },
  },
  [URLS.a1]: { status: 200, body: A1(), headers: { etag: '"a1-v1"' } },
  [URLS.a2]: { status: 200, body: A2() },
  [URLS.b1]: { status: 200, body: B1() },
});

/** What the fake LLM answers for each page. B1's price isn't on the page, so it's dropped. */
export function answerFor(user: string): Record<string, unknown> | null {
  if (user.includes('/products/a1')) {
    return {
      specs: [
        { label: 'Impedance', value: '300 Ω' },
        { label: 'Weight', value: '350 g' },
      ],
    };
  }
  if (user.includes('/products/a2')) return { specs: [{ label: 'Impedance', value: '32 Ω' }] };
  // Maker C's two pages say the same thing.
  if (user.includes('/products/c1') || user.includes('/products/c2')) {
    return { specs: [{ label: 'Impedance', value: '250 Ω' }] };
  }
  if (user.includes('/products/b1')) {
    return {
      specs: [
        { label: 'Output power', value: '1 W' },
        { label: 'Price', value: '$99' },
      ],
    };
  }
  return null;
}

/** A product page with only the JSON-LD a test gives it. */
export const productPage = (data: Record<string, unknown>) =>
  page(
    `<title>${String(data.name)}</title>${jsonLd({ '@type': 'Product', ...data })}`,
    `<h1>${String(data.name)}</h1>`,
  );

/**
 * What the fake decider answers: maker-a's pages are headphones, B1 is a DAC/amp, and every match
 * question is about unrelated products.
 */
export function decisionFor(request: DecisionRequest): Record<string, number> | null {
  if (request.type === 'classify') {
    return request.evidence.includes(URLS.b1) ? { 'DAC/Amp': 0.97 } : { Headphones: 0.97 };
  }
  if (request.type === 'match') return { unrelated: 0.97 };
  return null;
}

const C = (name: string, path: string, mpn: string) =>
  page(
    `<title>${name} | Maker C</title><link rel="canonical" href="https://maker-c.example/products/${path}">` +
      jsonLd({ '@type': 'Product', name, brand: { '@type': 'Brand', name: 'Maker C' }, mpn }),
    `<h1>${name}</h1><p>Impedance: 250 Ω</p>`,
  );
export const C1 = () => C('C1', 'c1', 'C1-250');
export const C2 = () => C('C2', 'c2', 'C2-32');

export const URLS_C = {
  c1: 'https://maker-c.example/products/c1',
  c2: 'https://maker-c.example/products/c2',
  card: 'https://maker-c.example/products/c1-gift-card',
} as const;

export const SITEMAPS = {
  index: 'https://maker-c.example/sitemap.xml',
  products: 'https://maker-c.example/sitemap_products_1.xml?from=1&to=9',
  pages: 'https://maker-c.example/sitemap_pages_1.xml',
} as const;

const xml = (text: string) => text.replaceAll('&', '&amp;');

/** Maker C's index, naming its product sitemap and a sitemap of other pages. */
export const sitemapIndex = () =>
  '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  `<sitemap><loc>${xml(SITEMAPS.products)}</loc></sitemap><sitemap><loc>${SITEMAPS.pages}</loc></sitemap>` +
  '</sitemapindex>';

/** A urlset of these pages. */
export const productSitemap = (entries: { loc: string; lastmod?: string }[]) =>
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  entries
    .map(
      (entry) =>
        `<url><loc>${xml(entry.loc)}</loc>${entry.lastmod === undefined ? '' : `<lastmod>${entry.lastmod}</lastmod>`}</url>`,
    )
    .join('') +
  '</urlset>';

/** The standard routes, and Maker C's robots.txt, sitemaps, and pages. */
export const sitemapRoutes = (): Record<string, Reply> => ({
  ...standardRoutes(),
  'https://maker-c.example/robots.txt': {
    status: 200,
    body: `${ROBOTS_OPEN}Sitemap: ${SITEMAPS.index}\n`,
    headers: { 'content-type': 'text/plain' },
  },
  [SITEMAPS.index]: {
    status: 200,
    body: sitemapIndex(),
    headers: { 'content-type': 'application/xml' },
  },
  [SITEMAPS.products]: {
    status: 200,
    body: productSitemap([
      { loc: 'https://maker-c.example/', lastmod: '2026-10-10' },
      { loc: URLS_C.c1, lastmod: '2026-10-01' },
      { loc: URLS_C.c2 },
      { loc: URLS_C.card },
      { loc: 'https://shop.maker-c.example/products/c3' },
    ]),
    // Moondrop sends its sitemap as RSS: the type is never trusted, the content is read.
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  },
  [SITEMAPS.pages]: {
    status: 200,
    body: productSitemap([{ loc: 'https://maker-c.example/about' }]),
  },
  [URLS_C.c1]: { status: 200, body: C1() },
  [URLS_C.c2]: { status: 200, body: C2() },
});
