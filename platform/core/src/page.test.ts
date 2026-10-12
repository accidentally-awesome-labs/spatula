import { describe, expect, it } from 'vitest';
import { jsonLdTypes, MAX_NESTING, nestingDepth, parsePage, PAGE_TEXT_MAX } from './page';
import { costRatio } from './testing/cost';

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

  it('refuses a canonical address with a username or password, and drops credentials from the page address too', () => {
    const linked = parsePage(
      '<link rel="canonical" href="https://u:pw@maker.example/p/7">',
      'https://maker.example/p/7',
    );
    expect(linked.canonicalUrl).toBe('https://maker.example/p/7');
    const credentialed = parsePage('<p>Hello</p>', 'https://u:pw@maker.example/p/7');
    expect(credentialed.canonicalUrl).toBe('https://maker.example/p/7');
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

describe('parsePage, JSON-LD and meta', () => {
  it('spreads mainEntity, given as an object or as a list, in document order', () => {
    const page = parsePage(
      '<script type="application/ld+json">{"@type":"WebPage","mainEntity":{"@type":"Product","name":"A"}}</script>' +
        '<script type="application/ld+json">{"@type":"WebPage","mainEntity":[{"@type":"Product","name":"B"},{"@type":"Offer","name":"C"}]}</script>',
      'https://maker.example/a',
    );
    expect(page.jsonLd.map((node) => jsonLdTypes(node))).toEqual([
      ['WebPage'],
      ['Product'],
      ['WebPage'],
      ['Product'],
      ['Offer'],
    ]);
    expect(page.jsonLd.map((node) => node.name)).toEqual([undefined, 'A', undefined, 'B', 'C']);
  });

  it('reads a mixed-case meta key lowercased, with each of its values in order', () => {
    const page = parsePage(
      '<meta property="Product:Brand" content="Audeze"><meta property="Product:Brand" content=" Audeze LLC ">',
      'https://maker.example/a',
    );
    expect(page.meta.get('product:brand')).toEqual(['Audeze', 'Audeze LLC']);
    expect(page.meta.has('Product:Brand')).toBe(false);
  });

  it(
    'keeps every value of a key repeated 100,000 times, in order, in linear time',
    { timeout: 30_000 },
    () => {
      const repeated = (count: number) => {
        let html = '';
        for (let index = 0; index < count; index += 1)
          html += `<meta name="x" content="v${index}">`;
        return html;
      };
      const page = parsePage(repeated(100_000), 'https://maker.example/a');
      const values = page.meta.get('x');
      expect(values).toHaveLength(100_000);
      expect(values?.[0]).toBe('v0');
      expect(values?.at(-1)).toBe('v99999');
      // Copying the list of values for every tag made each tag cost about nine times as much among
      // 20,000 as among a sixteenth of them. Adding to the list costs about the same at any size.
      const [small, large] = [repeated(1_250), repeated(20_000)];
      const parse = (html: string) => () => parsePage(html, 'https://maker.example/a');
      expect(costRatio(parse(small), parse(large), 16)).toBeLessThan(4);
    },
  );
});

describe('parsePage, text', () => {
  it('leaves out body-level scripts, styles, noscript, and SVG, with their text', () => {
    const page = parsePage(
      '<body><p>Visible</p><script type="application/json">{"blob":"hidden"}</script>' +
        '<style>p { color: red; }</style><noscript><p>Enable JavaScript</p></noscript>' +
        '<svg><title>Icon</title><text>Label</text></svg></body>',
      'https://maker.example/a',
    );
    expect(page.text).toBe('Visible');
  });

  it('leaves the same things out of <main>', () => {
    const page = parsePage(
      '<main><p>Visible</p><script>var hidden = 1;</script><style>p {}</style><noscript>Enable JavaScript</noscript><svg><title>Icon</title></svg></main>',
      'https://maker.example/a',
    );
    expect(page.text).toBe('Visible');
  });

  // The hostile case: the nesting guard refuses it before htmlparser2 builds a tree.
  it('refuses markup nested 20,000 elements deep', () => {
    expect(() =>
      parsePage(
        `${'<div>'.repeat(20_000)}Deep${'</div>'.repeat(20_000)}`,
        'https://maker.example/a',
      ),
    ).toThrow('the page nests elements 20,000 deep, more than 10,000');
  });

  it('never cuts a surrogate pair at the length cap', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const cut = parsePage(
      `<p>${'a'.repeat(PAGE_TEXT_MAX - 1)}${emoji}b</p>`,
      'https://maker.example/a',
    );
    expect(cut.text).toBe('a'.repeat(PAGE_TEXT_MAX - 1));
    expect(cut.text.isWellFormed()).toBe(true);

    const whole = parsePage(
      `<p>${'a'.repeat(PAGE_TEXT_MAX - 2)}${emoji}</p>`,
      'https://maker.example/a',
    );
    expect(whole.text.length).toBe(PAGE_TEXT_MAX);
    expect(whole.text.endsWith(emoji)).toBe(true);
  });
});

describe('select', () => {
  it('collapses inner whitespace in text and in attributes', () => {
    const page = parsePage(
      '<h1>  LCD-X   Pro </h1><a href="/x" title="  Open   back  ">Shop</a>',
      'https://maker.example/a',
    );
    expect(page.select('h1')).toBe('LCD-X Pro');
    expect(page.select('a', 'title')).toBe('Open back');
  });

  it('finds an attribute whatever the case of its name', () => {
    const page = parsePage('<a href="https://maker.example/x">Shop</a>', 'https://maker.example/a');
    expect(page.select('a', 'HREF')).toBe('https://maker.example/x');
  });

  it('finds nothing for names that only objects have, such as constructor and __proto__', () => {
    const page = parsePage('<h1 class="title">LCD-X</h1>', 'https://maker.example/a');
    expect(page.select('h1', 'constructor')).toBeNull();
    expect(page.select('h1', '__proto__')).toBeNull();
  });
});

describe('jsonLdTypes', () => {
  it('reads strings and lists, without schema.org prefixes', () => {
    expect(jsonLdTypes({ '@type': 'https://schema.org/ProductGroup' })).toEqual(['ProductGroup']);
    expect(jsonLdTypes({ '@type': ['Product', 7, 'schema:Thing'] })).toEqual(['Product', 'Thing']);
    expect(jsonLdTypes({})).toEqual([]);
  });
});

describe('nestingDepth', () => {
  it('counts elements left open, but not empty ones or those whose end tags may be left out', () => {
    expect(nestingDepth('<div><span><b>x</b></span></div>')).toBe(3);
    expect(nestingDepth('<div><br><img src="x"><input/><hr /></div>')).toBe(1);
    expect(nestingDepth(`<ul>${'<li>item'.repeat(1000)}</ul>`)).toBe(1);
    expect(nestingDepth('<p>one<p>two<p>three')).toBe(0);
    expect(nestingDepth('<!doctype html><html><body><main></main></body></html>')).toBe(3);
  });

  it('reads scripts, styles, and comments as text', () => {
    const page =
      '<script>"<div><div><div>"</script><style>a<b{}</style><!-- <div><div> --><main></main>';
    expect(nestingDepth(page)).toBe(1);
  });

  it('takes time in proportion to the page’s length', () => {
    const small = '<div>'.repeat(500);
    const large = '<div>'.repeat(50_000);
    expect(
      costRatio(
        () => nestingDepth(small),
        () => nestingDepth(large),
        100,
      ),
    ).toBeLessThan(4);
  });
});

describe('parsePage on a page nested deeper than any real one', () => {
  it('refuses it before parsing it', () => {
    const deep = '<div>'.repeat(MAX_NESTING + 1);
    expect(() => parsePage(deep, 'https://maker-a.example/products/deep')).toThrow(
      'the page nests elements 10,001 deep, more than 10,000',
    );
  });

  // Nearly the deepest page that's read, and htmlparser2's time grows with the square of the depth.
  it('reads a page just inside the limit', { timeout: 30_000 }, () => {
    const page = parsePage(
      `${'<div>'.repeat(MAX_NESTING - 2)}<h1>A1</h1>`,
      'https://maker-a.example/p',
    );
    expect(page.select('h1')).toBe('A1');
  });
});
