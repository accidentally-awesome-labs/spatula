import { describe, expect, it } from 'vitest';
import { jsonLdTypes, MAX_NESTING, parsePage, PAGE_TEXT_MAX } from './page';
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

describe('parsePage on a page nested deeper than any real one', () => {
  const PAGE_URL = 'https://maker-a.example/p';
  const TOO_DEEP = 'the page nests elements more than 1,000 deep';

  // Each of these makes htmlparser2 build a tree more than MAX_NESTING deep, from far less text than
  // a real page. The depth is read from the parser's own stack because a guess made from the text
  // was blind to every one but the first: it read each of the others as nesting nothing.
  it.each([
    ['plain elements', '<div>'.repeat(2_000)],
    ['a "<" that opens no tag before each element', '< <div>'.repeat(2_000)],
    ['an empty comment before the elements', `<!-->${'<div>'.repeat(2_000)}`],
    ['elements that nothing closes, such as <caption>', '<caption>'.repeat(2_000)],
    ['elements closed with a slash, which HTML ignores', '<div/>'.repeat(2_000)],
    ['pairs of elements whose end tags may be left out', '<li><p>'.repeat(1_000)],
  ])('refuses %s', (_what, deep) => {
    expect(() => parsePage(deep, PAGE_URL)).toThrow(TOO_DEEP);
  });

  it('reads a page exactly MAX_NESTING deep, and refuses one a level deeper', () => {
    const exactly = parsePage(`${'<div>'.repeat(MAX_NESTING - 1)}<h1>A1</h1>`, PAGE_URL);
    expect(exactly.select('h1')).toBe('A1');
    expect(() => parsePage(`${'<div>'.repeat(MAX_NESTING)}<h1>A1</h1>`, PAGE_URL)).toThrow(
      TOO_DEEP,
    );
  });

  it('reads sibling subtrees that are each MAX_NESTING deep, because depth does not add up', () => {
    const subtree = `${'<div>'.repeat(MAX_NESTING - 1)}<h1>A1</h1>${'</div>'.repeat(MAX_NESTING - 1)}`;
    const page = parsePage(subtree.repeat(50), PAGE_URL);
    expect(page.text).toBe(Array.from({ length: 50 }, () => 'A1').join(' '));
  });

  it('costs the same to refuse a page however far past the limit it goes', () => {
    // It stops at the first level past the limit, so a page 16 times as deep costs about what a
    // shallower one does. Parsing the rest first would cost as much as the page is long, or more.
    const refuse = (html: string) => () => {
      try {
        parsePage(html, PAGE_URL);
      } catch {
        return;
      }
      throw new Error('the page was read, not refused');
    };
    const near = refuse('<li><p>'.repeat(2_000));
    const far = refuse('<li><p>'.repeat(32_000));
    expect(costRatio(near, far, 16)).toBeLessThan(0.5);
  });
});

describe('what a page says about itself', () => {
  it('reads its title, on one line', () => {
    const page = parsePage(
      '<html><head><title>\n  Mojo 2 -\n Chord Electronics Ltd </title></head><body></body></html>',
      'https://chord.example/product/mojo-2',
    );
    expect(page.title).toBe('Mojo 2 - Chord Electronics Ltd');
    expect(parsePage('<p>no title</p>', 'https://chord.example/').title).toBeNull();
  });

  it('reads its JSON-LD breadcrumbs, in position order', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Mojo 2 - Chord Electronics Ltd' },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 3, name: 'Mojo 2' },
            {
              '@type': 'ListItem',
              position: 1,
              item: { '@id': 'https://chord.example/', name: 'Home' },
            },
            { '@type': 'ListItem', position: '2', name: '  Products ' },
            { '@type': 'ListItem', position: 4 },
          ],
        },
      ],
    };
    const page = parsePage(
      `<script type="application/ld+json">${JSON.stringify(graph)}</script>`,
      'https://chord.example/product/mojo-2',
    );
    expect(page.breadcrumbs).toEqual(['Home', 'Products', 'Mojo 2']);
    expect(parsePage('<p></p>', 'https://chord.example/').breadcrumbs).toEqual([]);
  });
});

describe('a page’s title and breadcrumbs, on odd and hostile pages', () => {
  const PAGE_URL = 'https://chord.example/product/mojo-2';
  const titleOf = (html: string) => parsePage(html, PAGE_URL).title;
  const ldScript = (json: string) => `<script type="application/ld+json">${json}</script>`;
  const crumbsOf = (value: unknown) =>
    parsePage(ldScript(JSON.stringify(value)), PAGE_URL).breadcrumbs;
  const listOf = (itemListElement: unknown) => ({ '@type': 'BreadcrumbList', itemListElement });
  const crumb = (position: unknown, name: unknown) => ({ '@type': 'ListItem', position, name });
  // One character, written as two UTF-16 halves.
  const EMOJI = String.fromCodePoint(0x1f600);

  it('reads the page’s own <title>, not one an SVG icon carries', () => {
    // An icon's <svg><title> only labels the icon. It can come ahead of the page's own title...
    expect(
      titleOf('<head><svg><title>Menu</title></svg><title>Mojo 2 - Chord</title></head>'),
    ).toBe('Mojo 2 - Chord');
    // ...however deep in the icon it sits...
    expect(
      titleOf('<svg><g><g><title>Menu</title></g></g></svg><title>Mojo 2 - Chord</title>'),
    ).toBe('Mojo 2 - Chord');
    // ...and a page whose only title is an icon's has none.
    expect(titleOf('<body><svg><title>Menu</title></svg></body>')).toBeNull();
    // The head comes first in a document, so its title wins over one further down.
    expect(
      titleOf(
        '<html><head><title>Mojo 2</title></head><body><div><title>Menu</title></div></body></html>',
      ),
    ).toBe('Mojo 2');
  });

  it(
    'finds no title among 20,000 icon titles at the deepest nesting, at the cost of parsing',
    { timeout: 30_000 },
    () => {
      // Looking up from each title for an <svg> costs up to MAX_NESTING steps a title, about 24
      // microseconds: 25 times what parsing it costs. Not entering the <svg> costs nothing. The
      // other page is the same size, with <tspan> where this one has <title>.
      const icons = (tag: string) =>
        `<svg>${'<g>'.repeat(MAX_NESTING - 2)}${`<${tag}>x</${tag}>`.repeat(20_000)}`;
      const titles = icons('title');
      const others = icons('tspan');
      expect(parsePage(titles, PAGE_URL).title).toBeNull();
      const parse = (html: string) => () => parsePage(html, PAGE_URL);
      expect(costRatio(parse(others), parse(titles), 1)).toBeLessThan(4);
    },
  );

  it('keeps a title to 300 characters, and drops the half of a surrogate pair that the cut leaves', () => {
    expect(titleOf(`<title>${'a'.repeat(400)}</title>`)).toBe('a'.repeat(300));
    // The 300th character is the first half of a pair, which is dropped with its other half.
    expect(titleOf(`<title>${'a'.repeat(299)}${EMOJI}b</title>`)).toBe('a'.repeat(299));
    // A pair that fits whole stays.
    expect(titleOf(`<title>${'a'.repeat(298)}${EMOJI}b</title>`)).toBe(
      `${'a'.repeat(298)}${EMOJI}`,
    );
  });

  it('ends neither a title nor a breadcrumb in the space that a cut leaves', () => {
    expect(titleOf(`<title>${'a'.repeat(299)} b</title>`)).toBe('a'.repeat(299));
    expect(crumbsOf(listOf([crumb(1, `${'n'.repeat(99)} m`)]))).toEqual(['n'.repeat(99)]);
    // Dropping half a pair can leave a space at the end too.
    expect(titleOf(`<title>${'a'.repeat(298)} ${EMOJI}b</title>`)).toBe('a'.repeat(298));
  });

  it('keeps 10 breadcrumbs of 100 characters at most, and reads only the first 50 entries', () => {
    const named = (count: number, position: (index: number) => number) =>
      Array.from({ length: count }, (_, index) => crumb(position(index), `c${position(index)}`));
    // Sixty in order: the first ten.
    expect(crumbsOf(listOf(named(60, (index) => index + 1)))).toEqual(
      Array.from({ length: 10 }, (_, index) => `c${index + 1}`),
    );
    // Sixty in reverse: the last ten, the lowest positions, are never read, so the ten lowest of the
    // first fifty are kept.
    expect(crumbsOf(listOf(named(60, (index) => 60 - index)))).toEqual(
      Array.from({ length: 10 }, (_, index) => `c${index + 11}`),
    );
    // A name is cut at 100 characters, and not through a surrogate pair.
    expect(crumbsOf(listOf([crumb(1, 'n'.repeat(150))]))).toEqual(['n'.repeat(100)]);
    expect(crumbsOf(listOf([crumb(1, `${'n'.repeat(99)}${EMOJI}x`)]))).toEqual(['n'.repeat(99)]);
  });

  it('puts a crumb whose position is no number where it stands in the list', () => {
    // null, "", and [] all turn into 0 when coerced, which would put them ahead of "Home".
    const list = listOf([
      crumb(1, 'Home'),
      crumb(null, 'Products'),
      crumb('', 'Audio'),
      crumb([], 'Mojo'),
      crumb('  ', 'Mojo 2'),
      crumb({}, 'Mojo 2 Black'),
      crumb(true, 'Stand'),
    ]);
    expect(crumbsOf(list)).toEqual([
      'Home',
      'Products',
      'Audio',
      'Mojo',
      'Mojo 2',
      'Mojo 2 Black',
      'Stand',
    ]);
    // Numbers and numeric strings still say where they go.
    expect(crumbsOf(listOf([crumb('2', 'B'), crumb(1.5, 'A'), crumb(' 3 ', 'C')]))).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('reads a page whose breadcrumb position is an array nested 10,000 deep', () => {
    // Coercing that array to a number recurses once for every level, and throws a RangeError.
    const deep = `${'['.repeat(10_000)}1${']'.repeat(10_000)}`;
    const page = parsePage(
      ldScript('{"@type":"Product","name":"Mojo 2"}') +
        ldScript(
          `{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":${deep},"name":"Home"},` +
            '{"@type":"ListItem","position":2,"name":"Products"}]}',
        ),
      PAGE_URL,
    );
    expect(page.jsonLd.map((node) => node.name)).toEqual(['Mojo 2', undefined]);
    expect(page.breadcrumbs).toEqual(['Home', 'Products']);
  });

  it('reads a breadcrumb list given as one object, which JSON-LD allows for a list of one', () => {
    expect(crumbsOf(listOf(crumb(1, 'Home')))).toEqual(['Home']);
    // Anything else that is not a list is no list of crumbs.
    expect(crumbsOf(listOf('Home'))).toEqual([]);
    expect(crumbsOf(listOf(null))).toEqual([]);
  });

  it('reads a breadcrumb list under a WebPage’s breadcrumb property', () => {
    const page = parsePage(
      ldScript(
        JSON.stringify({
          '@type': 'WebPage',
          name: 'Mojo 2',
          breadcrumb: listOf([crumb(1, 'Home'), crumb(2, 'Mojo 2')]),
        }),
      ),
      PAGE_URL,
    );
    expect(page.breadcrumbs).toEqual(['Home', 'Mojo 2']);
    expect(page.jsonLd.map((node) => jsonLdTypes(node))).toEqual([['WebPage'], ['BreadcrumbList']]);
    // A breadcrumb that is only a reference, or text, adds nothing.
    const referred = parsePage(
      ldScript('{"@type":"WebPage","breadcrumb":{"@id":"https://chord.example/#breadcrumb"}}') +
        ldScript('{"@type":"WebPage","breadcrumb":"Home > Mojo 2"}'),
      PAGE_URL,
    );
    expect(referred.jsonLd).toHaveLength(2);
    expect(referred.breadcrumbs).toEqual([]);
  });

  it('follows breadcrumb no deeper than it follows @graph and mainEntity', () => {
    const nested = (levels: number): unknown =>
      levels === 0
        ? listOf([crumb(1, 'Home')])
        : { '@type': 'WebPage', breadcrumb: nested(levels - 1) };
    expect(crumbsOf(nested(3))).toEqual(['Home']);
    // A page can nest the property as deep as it likes: the walk stops at the same depth it stops
    // at for @graph and mainEntity, and doesn't recurse as far as the page does.
    const deep = `${'{"@type":"WebPage","breadcrumb":'.repeat(20_000)}null${'}'.repeat(20_000)}`;
    const page = parsePage(ldScript(deep), PAGE_URL);
    expect(page.jsonLd.length).toBeLessThanOrEqual(10);
    expect(page.breadcrumbs).toEqual([]);
  });
});
