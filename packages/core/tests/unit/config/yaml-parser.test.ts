import { describe, it, expect } from 'vitest';
import { parseProjectYaml, expandFieldShorthand } from '../../../src/config/yaml-parser.js';

describe('expandFieldShorthand', () => {
  it('expands shorthand "name: type" to full field definition', () => {
    const input = { product_name: 'string' };
    const result = expandFieldShorthand(input);
    expect(result).toEqual({
      name: 'product_name',
      type: 'string',
      description: 'product_name',
      required: false,
    });
  });

  it('passes through expanded form with field key', () => {
    const input = { field: 'price', type: 'currency', required: true, selector: '.price' };
    const result = expandFieldShorthand(input);
    expect(result).toEqual({
      name: 'price',
      type: 'currency',
      description: 'price',
      required: true,
    });
  });

  it('uses description from expanded form if provided', () => {
    const input = { field: 'title', type: 'string', description: 'Product title' };
    const result = expandFieldShorthand(input);
    expect(result.description).toBe('Product title');
  });
});

describe('parseProjectYaml', () => {
  it('parses minimal config (seeds only)', () => {
    const yaml = `
seeds:
  - https://example.com/products
`;
    const result = parseProjectYaml(yaml);
    expect(result.seeds).toEqual(['https://example.com/products']);
  });

  it('parses tier 2 config with field shorthand', () => {
    const yaml = `
name: Acme Products
seeds:
  - https://acme.com/products
fields:
  - product_name: string
  - price: currency
depth: 3
limit: 2000
`;
    const result = parseProjectYaml(yaml);
    expect(result.name).toBe('Acme Products');
    expect(result.seeds).toHaveLength(1);
    expect(result.fields).toHaveLength(2);
    expect(result.depth).toBe(3);
    expect(result.limit).toBe(2000);
  });

  it('parses tier 3 config with nested sections', () => {
    const yaml = `
name: Full Config
seeds:
  - https://example.com
fields:
  - field: price
    type: currency
    required: true
    selector: ".price-current"
depth: 3
limit: 2000
crawler: playwright
safety: balanced
crawl:
  concurrency: 5
  proxy:
    url: socks5://127.0.0.1:1080
schema:
  mode: hybrid
  evolution:
    batchSize: 10
llm:
  model: anthropic/claude-sonnet-4-20250514
  overrides:
    linkEvaluation: anthropic/claude-3-haiku-20240307
reconciliation:
  strategy: composite_key
export:
  format: json
  autoExport: true
`;
    const result = parseProjectYaml(yaml);
    expect(result.name).toBe('Full Config');
    expect(result.crawler).toBe('playwright');
    expect(result.safety).toBe('balanced');
    expect(result.crawl?.concurrency).toBe(5);
    expect(result.crawl?.proxy?.url).toBe('socks5://127.0.0.1:1080');
    expect(result.schema?.mode).toBe('hybrid');
    expect(result.schema?.evolution?.batchSize).toBe(10);
    expect(result.llm?.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.reconciliation?.strategy).toBe('composite_key');
    expect(result.export?.format).toBe('json');
    expect(result.export?.autoExport).toBe(true);
  });

  it('throws ValidationError on missing seeds', () => {
    const yaml = `
name: No Seeds
`;
    expect(() => parseProjectYaml(yaml)).toThrow('seeds');
  });

  it('throws ValidationError on invalid seed URL', () => {
    const yaml = `
seeds:
  - not-a-url
`;
    expect(() => parseProjectYaml(yaml)).toThrow();
  });

  it('throws on unknown top-level keys (strict mode)', () => {
    const yaml = `
seeds:
  - https://example.com
unknown_key: value
`;
    expect(() => parseProjectYaml(yaml)).toThrow();
  });

  it('handles mixed field formats (shorthand + expanded)', () => {
    const yaml = `
seeds:
  - https://example.com
fields:
  - product_name: string
  - field: price
    type: currency
    required: true
`;
    const result = parseProjectYaml(yaml);
    expect(result.fields).toHaveLength(2);
  });
});
