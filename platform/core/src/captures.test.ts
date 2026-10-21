import { describe, expect, it } from 'vitest';
import { gunzip, gzip, PAGE_READ_VERSION, pageRead, parsePageRead } from './captures';
import { parsePage } from './page';

const jsonLd = (data: object) =>
  `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data })}</script>`;

const PAGE =
  '<!doctype html><html><head><title>A1 | Maker A</title>' +
  '<meta property="og:title" content="A1 Headphones"><meta name="description" content="Open-back">' +
  '<link rel="canonical" href="https://maker-a.example/products/a1">' +
  jsonLd({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Headphones' },
      { '@type': 'ListItem', position: 2, name: 'A1' },
    ],
  }) +
  jsonLd({ '@type': 'Product', name: 'A1', category: 'Headphones' }) +
  '</head><body><main><h1>A1</h1><p>Impedance: 300 Ω</p></main></body></html>';

describe('gzip and gunzip', () => {
  it('give back the bytes they were given', { timeout: 30_000 }, async () => {
    const text = `${'Impedance: 300 Ω. '.repeat(100_000)}end`;
    const body = new TextEncoder().encode(text);
    const packed = await gzip(body);
    expect([...packed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(packed.byteLength).toBeLessThan(body.byteLength / 10);
    // Compared as text: a deep equality over two megabytes of bytes takes most of a minute in CI.
    const unpacked = await gunzip(packed);
    expect(unpacked.byteLength).toBe(body.byteLength);
    expect(new TextDecoder().decode(unpacked)).toBe(text);
    expect(await gunzip(await gzip(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('refuse bytes that aren’t gzip', async () => {
    await expect(gunzip(new TextEncoder().encode('<html></html>'))).rejects.toThrow();
  });
});

describe('pageRead', () => {
  it('keeps what Spatula read from a page, as JSON that reads back', () => {
    const read = pageRead(parsePage(PAGE, 'https://maker-a.example/products/a1?variant=2'));
    expect(read).toEqual({
      reader: PAGE_READ_VERSION,
      url: 'https://maker-a.example/products/a1?variant=2',
      canonicalUrl: 'https://maker-a.example/products/a1',
      title: 'A1 | Maker A',
      breadcrumbs: ['Headphones', 'A1'],
      jsonLd: [
        expect.objectContaining({ '@type': 'BreadcrumbList' }),
        expect.objectContaining({ '@type': 'Product', name: 'A1', category: 'Headphones' }),
      ],
      jsonLdErrors: 0,
      meta: { 'og:title': ['A1 Headphones'], description: ['Open-back'] },
      text: 'A1 Impedance: 300 Ω',
    });
    expect(parsePageRead(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });

  it('keeps a meta tag called __proto__ as a key of its own, not as a prototype', () => {
    const page = parsePage(
      '<html><head><meta name="__proto__" content="x"></head><body></body></html>',
      'https://maker-a.example/',
    );
    const read = parsePageRead(JSON.parse(JSON.stringify(pageRead(page))))!;
    expect(Object.hasOwn(read.meta, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(read.meta)).toBe(Object.prototype);
  });

  it('refuses what isn’t a read', () => {
    expect(parsePageRead(null)).toBeNull();
    expect(parsePageRead([])).toBeNull();
    expect(parsePageRead({ reader: 1, url: 'https://maker-a.example/' })).toBeNull();
    const read = pageRead(parsePage(PAGE, 'https://maker-a.example/products/a1'));
    expect(parsePageRead({ ...read, breadcrumbs: [1] })).toBeNull();
    expect(parsePageRead({ ...read, meta: [] })).toBeNull();
  });
});
