/*
 * The test definition's three pages, as small as they can be while still being like the real ones.
 * A1's JSON-LD puts its UPC in `mpn`, as Audeze's pages do. A2's has a GTIN and a part number.
 * B1 has no structured data, so its source declares where the name is. Every page carries a token
 * in its head that changes on every fetch, as Shopify's do, while its text stays the same.
 */

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
