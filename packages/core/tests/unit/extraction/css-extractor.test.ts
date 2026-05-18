import { describe, it, expect } from 'vitest';
import { CssExtractor } from '../../../src/extraction/css-extractor.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const makeSchema = (fields: Array<{ name: string; type: string }>): SchemaDefinition => ({
  version: 1,
  fields: fields.map((f) => ({
    name: f.name,
    type: f.type,
    description: f.name,
    required: false,
  })),
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
});

describe('CssExtractor', () => {
  const extractor = new CssExtractor();

  it('extracts text from headings', async () => {
    const html = '<html><body><h1>Product Name</h1><p>Description here</p></body></html>';
    const schema = makeSchema([{ name: 'title', type: 'string' }]);
    const result = await extractor.extract(
      html,
      'https://example.com',
      schema,
      'Extract product data',
    );
    expect(result.data).toBeDefined();
    expect(result.metadata.confidence).toBeGreaterThan(0);
    expect(result.metadata.modelUsed).toBe('css-extractor');
  });

  it('extracts prices from elements with currency patterns', async () => {
    const html = '<html><body><span class="price">$29.99</span></body></html>';
    const schema = makeSchema([{ name: 'price', type: 'currency' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract prices');
    expect(result.data.price).toBe('$29.99');
  });

  it('extracts image URLs', async () => {
    const html =
      '<html><body><img src="https://example.com/photo.jpg" alt="Product"></body></html>';
    const schema = makeSchema([{ name: 'image', type: 'url' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract images');
    expect(result.data.image).toBe('https://example.com/photo.jpg');
  });

  it('extracts links', async () => {
    const html = '<html><body><a href="https://example.com/page">Click here</a></body></html>';
    const schema = makeSchema([{ name: 'link', type: 'url' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract links');
    expect(result.data.link).toBe('https://example.com/page');
  });

  it('returns empty extraction with low confidence when no matches', async () => {
    const html = '<html><body><div></div></body></html>';
    const schema = makeSchema([{ name: 'title', type: 'string' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract data');
    expect(result.metadata.confidence).toBeLessThanOrEqual(0.1);
  });

  it('auto-discovers data when schema has no fields', async () => {
    const html = `<html><body>
      <h1>Main Title</h1>
      <h2>Subtitle</h2>
      <img src="https://example.com/img.png" alt="image">
      <a href="https://example.com/link">Link text</a>
      <span class="price">$19.99</span>
    </body></html>`;
    const schema = makeSchema([]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract data');
    expect(Object.keys(result.data).length).toBeGreaterThan(0);
  });

  it('resolves relative image URLs against base URL', async () => {
    const html = '<html><body><img src="/images/photo.jpg" alt="Photo"></body></html>';
    const schema = makeSchema([{ name: 'image', type: 'url' }]);
    const result = await extractor.extract(
      html,
      'https://example.com/products/1',
      schema,
      'Extract images',
    );
    expect(result.data.image).toBe('https://example.com/images/photo.jpg');
  });

  it('handles malformed HTML without crashing', async () => {
    const html = '<html><body><h1>Title<p>No closing tags<img src=broken>';
    const schema = makeSchema([{ name: 'title', type: 'string' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract data');
    expect(result).toBeDefined();
    expect(result.metadata.modelUsed).toBe('css-extractor');
  });

  it('extracts text from elements with matching class attribute', async () => {
    const html = '<html><body><span class="product-name">Widget Pro</span></body></html>';
    const schema = makeSchema([{ name: 'product_name', type: 'string' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract products');
    expect(result).toBeDefined();
  });

  it('extracts list items as arrays', async () => {
    const html = `<html><body>
      <ul class="features">
        <li>Feature A</li>
        <li>Feature B</li>
        <li>Feature C</li>
      </ul>
    </body></html>`;
    const schema = makeSchema([{ name: 'features', type: 'array' }]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract features');
    expect(Array.isArray(result.data.features)).toBe(true);
    expect(result.data.features).toContain('Feature A');
    expect(result.data.features).toHaveLength(3);
  });

  it('confidence is capped at 0.6 for CSS extraction', async () => {
    const html = '<html><body><h1>Title</h1><span class="price">$10</span></body></html>';
    const schema = makeSchema([
      { name: 'title', type: 'string' },
      { name: 'price', type: 'currency' },
    ]);
    const result = await extractor.extract(html, 'https://example.com', schema, 'Extract data');
    expect(result.metadata.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe('table extraction', () => {
  const extractor = new CssExtractor();
  const tableHtml = `<html><body><article>
    <table class="specs">
      <thead><tr><th>Name</th><th>Price</th><th>Rating</th></tr></thead>
      <tbody>
        <tr><td>Widget A</td><td>$10</td><td>4.5</td></tr>
        <tr><td>Widget B</td><td>$20</td><td>3.8</td></tr>
      </tbody>
    </table>
  </article></body></html>`;

  it('extracts table as array of objects when field is array+object', async () => {
    const schema = {
      version: 1,
      fields: [
        {
          name: 'specs',
          description: 'Specs table',
          type: 'array' as const,
          required: false,
          arrayItemType: {
            name: 'row',
            description: 'Row',
            type: 'object' as const,
            required: false,
          },
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(tableHtml, 'https://example.com', schema, '');
    expect(result.data.specs).toEqual([
      { Name: 'Widget A', Price: '$10', Rating: '4.5' },
      { Name: 'Widget B', Price: '$20', Rating: '3.8' },
    ]);
  });

  it('returns null when no table found', async () => {
    const schema = {
      version: 1,
      fields: [
        {
          name: 'specs',
          description: 'Specs',
          type: 'array' as const,
          required: false,
          arrayItemType: {
            name: 'row',
            description: 'Row',
            type: 'object' as const,
            required: false,
          },
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(
      '<html><body><p>No tables</p></body></html>',
      'https://example.com',
      schema,
      '',
    );
    expect(result.data.specs).toBeUndefined();
  });

  it('generates column headers when thead is missing', async () => {
    const html = `<html><body><table>
      <tr><td>A</td><td>B</td></tr>
      <tr><td>C</td><td>D</td></tr>
    </table></body></html>`;
    const schema = {
      version: 1,
      fields: [
        {
          name: 'data',
          description: 'Data',
          type: 'array' as const,
          required: false,
          arrayItemType: {
            name: 'row',
            description: 'Row',
            type: 'object' as const,
            required: false,
          },
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(html, 'https://example.com', schema, '');
    expect(result.data.data).toEqual([{ A: 'C', B: 'D' }]);
  });

  it('handles colspan by filling adjacent columns', async () => {
    const html = `<html><body><table>
      <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td colspan="2">Wide</td><td>Narrow</td></tr></tbody>
    </table></body></html>`;
    const schema = {
      version: 1,
      fields: [
        {
          name: 'data',
          description: 'Data',
          type: 'array' as const,
          required: false,
          arrayItemType: {
            name: 'row',
            description: 'Row',
            type: 'object' as const,
            required: false,
          },
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(html, 'https://example.com', schema, '');
    expect(result.data.data).toEqual([{ A: 'Wide', B: 'Wide', C: 'Narrow' }]);
  });

  it('includes tables in autoDiscover when 3+ data rows exist', async () => {
    const bigTableHtml = `<html><body><article>
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
          <tr><td>5</td><td>6</td></tr>
        </tbody>
      </table>
    </article></body></html>`;
    const schema = {
      version: 1,
      fields: [],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(bigTableHtml, 'https://example.com', schema, '');
    expect(result.data.tables).toBeDefined();
    expect(result.data.tables).toHaveLength(3);
  });

  it('skips tables in autoDiscover when fewer than 3 data rows', async () => {
    const schema = {
      version: 1,
      fields: [],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const result = await extractor.extract(tableHtml, 'https://example.com', schema, '');
    expect(result.data.tables).toBeUndefined();
  });
});
