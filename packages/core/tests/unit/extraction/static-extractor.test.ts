import { describe, it, expect, vi } from 'vitest';
import { ExtractionError } from '@spatula/shared';
import { StaticExtractor } from '../../../src/extraction/static-extractor.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

const testSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
    { name: 'description', description: 'Description', type: 'string', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

const sampleHtml = `
<html><body>
  <h1>Sony WH-1000XM5</h1>
  <p class="price">$379.99</p>
  <p>Industry-leading noise cancellation headphones.</p>
</body></html>
`;

describe('StaticExtractor', () => {
  it('extracts data from HTML and returns ExtractionResult', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: {
          product_name: 'Sony WH-1000XM5',
          price: { amount: 379.99, currency: 'USD' },
          description: 'Industry-leading noise cancellation headphones.',
        },
        _unmapped: [],
        confidence: 0.92,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-id-123');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com/product/123',
      testSchema,
      'audiophile headphones',
    );
    expect(result.jobId).toBe('job-id-123');
    expect(result.schemaVersion).toBe(1);
    expect(result.data.product_name).toBe('Sony WH-1000XM5');
    expect(result.data.price).toEqual({ amount: 379.99, currency: 'USD' });
    expect(result.metadata.confidence).toBe(0.92);
    expect(result.metadata.modelUsed).toBe('test-model');
    expect(result.metadata.tokensUsed).toBe(300);
    expect(result.metadata.extractionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.unmappedFields).toEqual([]);
    expect(result.id).toBeDefined();
    expect(result.pageId).toBeDefined();
  });

  it('captures unmapped fields in metadata', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: { product_name: 'Test' },
        _unmapped: [
          { name: 'driver_type', value: '40mm dynamic', suggestedType: 'string' },
          { name: 'weight', value: '250g', suggestedType: 'string' },
        ],
        confidence: 0.85,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com',
      testSchema,
      'products',
    );
    expect(result.metadata.unmappedFields).toHaveLength(2);
    expect(result.metadata.unmappedFields[0].name).toBe('driver_type');
    expect(result.metadata.unmappedFields[1].name).toBe('weight');
  });

  it('preserves inferred data and seeds unmapped fields when schema is empty', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: {
          product_name: 'Sony WH-1000XM5',
          price: '$379.99',
          __proto__: 'drop me',
        },
        _unmapped: [],
        confidence: 0.92,
      }),
    );
    const discoverySchema: SchemaDefinition = { ...testSchema, fields: [] };
    const extractor = new StaticExtractor(client, config, 'job-1');

    const result = await extractor.extract(
      sampleHtml,
      'https://example.com',
      discoverySchema,
      'products',
    );

    expect(result.data).toEqual({
      product_name: 'Sony WH-1000XM5',
      price: '$379.99',
    });
    expect(result.metadata.unmappedFields).toEqual(
      expect.arrayContaining([
        { name: 'product_name', value: 'Sony WH-1000XM5', suggestedType: 'string' },
        { name: 'price', value: '$379.99', suggestedType: 'currency' },
      ]),
    );
  });

  it('uses extraction model from config', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const configWithOverride: LLMConfig = {
      primaryModel: 'primary',
      modelOverrides: { extraction: 'extraction-model' },
    };
    const extractor = new StaticExtractor(client, configWithOverride, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'extraction-model' }),
    );
  });

  it('enables JSON mode for LLM request', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('returns empty extraction on invalid JSON from LLM', async () => {
    const client = createMockClient('totally not json {}{}');
    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(result.data).toEqual({});
    expect(result.metadata.confidence).toBe(0);
    expect(result.metadata.unmappedFields).toEqual([]);
  });

  it('throws ExtractionError when LLM client throws', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };
    const extractor = new StaticExtractor(client, config, 'job-1');
    await expect(
      extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test'),
    ).rejects.toThrow(ExtractionError);
  });

  it('generates unique ids for each extraction', async () => {
    const client = createMockClient(
      JSON.stringify({ data: { product_name: 'A' }, _unmapped: [], confidence: 0.9 }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');
    const r1 = await extractor.extract(sampleHtml, 'https://example.com/1', testSchema, 'test');
    const r2 = await extractor.extract(sampleHtml, 'https://example.com/2', testSchema, 'test');
    expect(r1.id).not.toBe(r2.id);
    expect(r1.pageId).not.toBe(r2.pageId);
  });

  it('includes schema fields description in LLM prompt', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');
    expect(userMessage).toContain('REQUIRED');
  });

  it('extracts multiple records from listing pages', async () => {
    const client = createMockClient(
      JSON.stringify({
        records: [
          {
            product_name: 'Product A',
            price: '$10',
            description: 'First product',
            admin_secret: 'drop me',
          },
          {
            product_name: 'Product B',
            price: '$20',
            description: 'Second product',
          },
        ],
        _unmapped: [],
        confidence: 0.88,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      sampleHtml,
      'https://example.com/category',
      testSchema,
      'products',
    );

    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({
      product_name: 'Product A',
      price: '$10',
      description: 'First product',
    });
    expect(results[1].data.product_name).toBe('Product B');
    expect(results[0].metadata.confidence).toBe(0.88);
  });

  it('extracts headered table rows deterministically before using the LLM', async () => {
    const client = createMockClient(
      JSON.stringify({ records: [], _unmapped: [], confidence: 0.1 }),
    );
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'tld', description: 'Top-level domain string', type: 'string', required: true },
        { name: 'type', description: 'Domain type or category', type: 'string', required: false },
        {
          name: 'manager',
          description: 'Sponsoring organization or manager',
          type: 'string',
          required: true,
        },
        {
          name: 'record_url',
          description: 'URL for the TLD record detail page',
          type: 'url',
          required: false,
        },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-01-01'),
      parentVersion: null,
    };
    const html = `<body><table>
      <thead><tr><th>Domain</th><th>Type</th><th>Sponsoring Organisation</th></tr></thead>
      <tbody>
        <tr><td><a href="/domains/root/db/aaa.html">.aaa</a></td><td>generic</td><td>American Automobile Association, Inc.</td></tr>
        <tr><td><a href="/domains/root/db/aarp.html">.aarp</a></td><td>generic</td><td>AARP</td></tr>
      </tbody>
    </table></body>`;
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      html,
      'https://www.iana.org/domains/root/db',
      schema,
      'Extract top-level domain records',
    );

    expect(client.complete).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({
      tld: '.aaa',
      type: 'generic',
      manager: 'American Automobile Association, Inc.',
      record_url: 'https://www.iana.org/domains/root/db/aaa.html',
    });
    expect(results[1].data.manager).toBe('AARP');
    expect(results[0].metadata.modelUsed).toBe('html-table-extractor');
  });

  it('extracts repeated semantic blocks deterministically before using the LLM', async () => {
    const client = createMockClient(
      JSON.stringify({ records: [], _unmapped: [], confidence: 0.1 }),
    );
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'country', description: 'Country name', type: 'string', required: true },
        { name: 'capital', description: 'Capital city', type: 'string', required: true },
        { name: 'population', description: 'Population value', type: 'number', required: true },
        {
          name: 'area_km2',
          description: 'Area in square kilometers',
          type: 'number',
          required: false,
        },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-01-01'),
      parentVersion: null,
    };
    const html = `<body>
      <div class="col-md-4 country">
        <h3 class="country-name">
          <i class="flag-icon flag-icon-ad"></i>
          Andorra
        </h3>
        <div class="country-info">
          <strong>Capital:</strong> <span class="country-capital">Andorra la Vella</span><br>
          <strong>Population:</strong> <span class="country-population">84000</span><br>
          <strong>Area (km<sup>2</sup>):</strong> <span class="country-area">468.0</span><br>
        </div>
      </div>
      <div class="col-md-4 country">
        <h3 class="country-name">
          <i class="flag-icon flag-icon-ae"></i>
          United Arab Emirates
        </h3>
        <div class="country-info">
          <strong>Capital:</strong> <span class="country-capital">Abu Dhabi</span><br>
          <strong>Population:</strong> <span class="country-population">4975593</span><br>
          <strong>Area (km<sup>2</sup>):</strong> <span class="country-area">82880.0</span><br>
        </div>
      </div>
    </body>`;
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      html,
      'https://www.scrapethissite.com/pages/simple/',
      schema,
      'Extract countries',
    );

    expect(client.complete).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({
      country: 'Andorra',
      capital: 'Andorra la Vella',
      population: 84000,
      area_km2: 468,
    });
    expect(results[1].data.country).toBe('United Arab Emirates');
    expect(results[0].metadata.modelUsed).toBe('html-block-extractor');
  });

  it('extracts product-card title attributes and class-based ratings deterministically', async () => {
    const client = createMockClient(
      JSON.stringify({ records: [], _unmapped: [], confidence: 0.1 }),
    );
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', description: 'Book title', type: 'string', required: true },
        {
          name: 'price',
          description: 'Book price including currency',
          type: 'currency',
          required: true,
        },
        {
          name: 'availability',
          description: 'Stock availability text',
          type: 'string',
          required: false,
        },
        {
          name: 'rating',
          description: 'Star rating, such as One through Five',
          type: 'string',
          required: false,
        },
        {
          name: 'product_url',
          description: 'URL of the product detail page',
          type: 'url',
          required: false,
        },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-01-01'),
      parentVersion: null,
    };
    const html = `<body><ol>
      <li class="col-xs-6 col-sm-4 col-md-3 col-lg-3">
        <article class="product_pod">
          <div class="image_container">
            <a href="https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html">
              <img alt="A Light in the Attic" class="thumbnail">
            </a>
          </div>
          <p class="star-rating Three"><i class="icon-star"></i></p>
          <h3><a href="https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html" title="A Light in the Attic">A Light in the ...</a></h3>
          <div class="product_price">
            <p class="price_color">£51.77</p>
            <p class="instock availability">In stock</p>
          </div>
        </article>
      </li>
      <li class="col-xs-6 col-sm-4 col-md-3 col-lg-3">
        <article class="product_pod">
          <div class="image_container">
            <a href="https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html">
              <img alt="Tipping the Velvet" class="thumbnail">
            </a>
          </div>
          <p class="star-rating One"><i class="icon-star"></i></p>
          <h3><a href="https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html" title="Tipping the Velvet">Tipping the Velvet</a></h3>
          <div class="product_price">
            <p class="price_color">£53.74</p>
            <p class="instock availability">In stock</p>
          </div>
        </article>
      </li>
    </ol></body>`;
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      html,
      'https://books.toscrape.com/',
      schema,
      'Extract book cards',
    );

    expect(client.complete).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({
      title: 'A Light in the Attic',
      price: '£51.77',
      availability: 'In stock',
      rating: 'Three',
      product_url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
    });
    expect(results[1].data.rating).toBe('One');
    expect(results[0].metadata.modelUsed).toBe('html-block-extractor');
  });

  it('accepts single-record extraction responses in multi-record mode', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: {
          product_name: 'Product A',
          price: '$10',
          description: 'First product',
          admin_secret: 'drop me',
        },
        _unmapped: [{ name: 'brand', value: 'Acme', suggestedType: 'string' }],
        confidence: 0.91,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      sampleHtml,
      'https://example.com/product-a',
      testSchema,
      'products',
    );

    expect(results).toHaveLength(1);
    expect(results[0].data).toEqual({
      product_name: 'Product A',
      price: '$10',
      description: 'First product',
    });
    expect(results[0].metadata.confidence).toBe(0.91);
    expect(results[0].metadata.unmappedFields).toEqual([
      { name: 'brand', value: 'Acme', suggestedType: 'string' },
    ]);
  });

  it('preserves inferred records in multi-record discovery mode', async () => {
    const client = createMockClient(
      JSON.stringify({
        records: [
          { product_name: 'Product A', price: '$10' },
          { product_name: 'Product B', price: '$20' },
        ],
        _unmapped: [],
        confidence: 0.88,
      }),
    );
    const discoverySchema: SchemaDefinition = { ...testSchema, fields: [] };
    const extractor = new StaticExtractor(client, config, 'job-1');

    const results = await extractor.extractMany!(
      sampleHtml,
      'https://example.com/category',
      discoverySchema,
      'products',
    );

    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({ product_name: 'Product A', price: '$10' });
    expect(results[0].metadata.unmappedFields).toEqual(
      expect.arrayContaining([
        { name: 'product_name', value: 'Product A', suggestedType: 'string' },
        { name: 'price', value: '$10', suggestedType: 'currency' },
      ]),
    );
  });

  it('chunks long listing pages and deduplicates records across chunks', async () => {
    let calls = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        calls++;
        return {
          content: JSON.stringify({
            records: [
              { product_name: 'Shared Product', price: '$1', description: 'Repeated' },
              {
                product_name: `Chunk Product ${calls}`,
                price: `$${calls}`,
                description: 'Chunk-specific',
              },
            ],
            _unmapped: [],
            confidence: 0.8,
          }),
          model: 'test-model',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: 'stop',
        } satisfies LLMCompletionResponse;
      }),
    };
    const extractor = new StaticExtractor(client, config, 'job-1');
    const longHtml = `<body>${Array.from(
      { length: 90 },
      (_, i) => `
        <article>
          <h2>Product ${i}</h2>
          <p>${'Long product detail. '.repeat(20)}</p>
          <p class="price">$${i}</p>
        </article>
      `,
    ).join('')}</body>`;

    const results = await extractor.extractMany!(
      longHtml,
      'https://example.com/category',
      testSchema,
      'products',
    );

    expect(client.complete).toHaveBeenCalledTimes(calls);
    expect(calls).toBeGreaterThan(1);
    expect(results.filter((result) => result.data.product_name === 'Shared Product')).toHaveLength(
      1,
    );
    expect(results).toHaveLength(calls + 1);
  });

  it('uses a list extraction prompt that mentions semantic attributes and hrefs', async () => {
    const client = createMockClient(
      JSON.stringify({
        records: [],
        _unmapped: [],
        confidence: 0.5,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');

    await extractor.extractMany!(
      '<body><a href="/p/1" title="Product A">A</a><p class="star-rating Three"></p></body>',
      'https://example.com/category',
      testSchema,
      'products',
    );

    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('"records"');
    expect(userMessage).toContain('href: /p/1');
    expect(userMessage).toContain('star-rating Three');
    expect(userMessage).toContain('rating "Three"');
  });
});
