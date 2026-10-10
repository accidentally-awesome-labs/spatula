import { describe, expect, it } from 'vitest';
import { jsonLdTypes, parsePage, PAGE_TEXT_MAX } from './page';

const SHOP_PAGE = `<!doctype html><html><head>
<title>LCD-X - Audeze</title>
<link rel="canonical" href="/products/lcd-x">
<meta property="og:type" content="product">
<meta property="og:title" content="LCD-X">
<meta name="twitter:title" content=" LCD-X ">
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Organization","name":"Audeze"}</script>
<script type="application/ld+json; charset=utf-8">{"@context":"http://schema.org/","@type":"Product","name":"LCD-X","mpn":"819343015004"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":["schema:Product"],"name":"LCD-X"}]}</script>
<script type="application/ld+json">{ "not": json </script>
<script>var page = "<p>not text</p>";</script>
</head><body>
<header><nav>Shop Headphones Support</nav></header>
<h1 class="title">LCD-X</h1>
<div class="specs"><p>Impedance: 20 &#937;</p><p>Weight:   612 g</p></div>
<footer>© Audeze</footer>
</body></html>`;

describe('parsePage', () => {
  const page = parsePage(SHOP_PAGE, 'https://www.audeze.com/products/lcd-x?variant=1');

  it('reads every JSON-LD object with a type, spreading @graph, and counts blocks that are not JSON', () => {
    expect(page.jsonLd.map((node) => jsonLdTypes(node))).toEqual([
      ['Organization'],
      ['Product'],
      ['BreadcrumbList'],
      ['Product'],
    ]);
    expect(page.jsonLdErrors).toBe(1);
  });

  it('reads meta tags by property or name, in order', () => {
    expect(page.meta.get('og:title')).toEqual(['LCD-X']);
    expect(page.meta.get('twitter:title')).toEqual(['LCD-X']);
    expect(page.meta.get('og:type')).toEqual(['product']);
  });

  it('resolves the canonical address on the same host', () => {
    expect(page.canonicalUrl).toBe('https://www.audeze.com/products/lcd-x');
  });

  it('keeps the main text without scripts, navigation, headers, or footers', () => {
    expect(page.text).toBe('LCD-X Impedance: 20 \u03a9 Weight: 612 g');
  });

  it('runs CSS rules for text or an attribute', () => {
    expect(page.select('h1')).toBe('LCD-X');
    expect(page.select('h1', 'class')).toBe('title');
    expect(page.select('.missing')).toBeNull();
  });
});

describe('parsePage, other pages', () => {
  it('reads only <main> when the page has one, headers inside it included', () => {
    const page = parsePage(
      '<body><nav>Menu</nav><main><header><h1>HD 650</h1></header><p>Open-back</p></main><footer>Legal</footer></body>',
      'https://us.sennheiser-hearing.com/products/hd-650',
    );
    expect(page.text).toBe('HD 650 Open-back');
  });

  it('ignores canonical links to other hosts or to http, and leaves out the fragment', () => {
    const elsewhere = parsePage(
      '<link rel="canonical" href="https://other.example/x">',
      'https://maker.example/a#top',
    );
    expect(elsewhere.canonicalUrl).toBe('https://maker.example/a');
    const plain = parsePage(
      '<link rel="canonical" href="http://maker.example/a">',
      'https://maker.example/a',
    );
    expect(plain.canonicalUrl).toBe('https://maker.example/a');
  });

  it('reads JSON-LD with raw line breaks inside strings', () => {
    const page = parsePage(
      '<script type="application/ld+json">{"@type":"Product","name":"LCD\n2"}</script>',
      'https://maker.example/a',
    );
    expect(page.jsonLd).toEqual([{ '@type': 'Product', name: 'LCD 2' }]);
    expect(page.jsonLdErrors).toBe(0);
  });

  it('caps the text at PAGE_TEXT_MAX characters', () => {
    const page = parsePage(`<p>${'word '.repeat(20_000)}</p>`, 'https://maker.example/a');
    expect(page.text.length).toBe(PAGE_TEXT_MAX);
  });
});

describe('jsonLdTypes', () => {
  it('reads strings and lists, without schema.org prefixes', () => {
    expect(jsonLdTypes({ '@type': 'https://schema.org/ProductGroup' })).toEqual(['ProductGroup']);
    expect(jsonLdTypes({ '@type': ['Product', 7, 'schema:Thing'] })).toEqual(['Product', 'Thing']);
    expect(jsonLdTypes({})).toEqual([]);
  });
});
