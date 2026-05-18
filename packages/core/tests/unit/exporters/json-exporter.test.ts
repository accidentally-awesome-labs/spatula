import { describe, it, expect } from 'vitest';
import { JsonExporter } from '../../../src/exporters/json-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'number', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  { mergedData: { name: 'A', price: 10 }, qualityScore: 0.9, categories: ['test'], sourceCount: 2 },
];

describe('JsonExporter', () => {
  it('has format json', () => {
    expect(new JsonExporter().format).toBe('json');
  });

  it('exports entities as JSON array', async () => {
    const result = await new JsonExporter().export(entities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect(result.entityCount).toBe(1);
    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.data as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].data.name).toBe('A');
    expect(parsed[0].qualityScore).toBe(0.9);
  });

  it('includes provenance when requested', async () => {
    const withProv = [
      {
        mergedData: { name: 'A' },
        qualityScore: 0.9,
        categories: [],
        sourceCount: 1,
        provenance: { name: { provenanceType: 'extracted' } },
        sources: [{ extractionId: 'ext-1', matchConfidence: 0.9 }],
      },
    ];
    const result = await new JsonExporter().export(withProv, schema, {
      format: 'json',
      includeProvenance: true,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeDefined();
    expect(parsed[0].sources).toBeDefined();
  });

  it('excludes provenance by default', async () => {
    const result = await new JsonExporter().export(entities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeUndefined();
  });

  it('handles special characters in field values', async () => {
    const specialEntities = [
      {
        mergedData: {
          name: 'Quote "test" and back\\slash',
          price: 0,
          description: 'Line1\nLine2\ttab',
          unicode: '\u00e9\u00e8\u00ea \u2603 \ud83d\ude00 \u4e16\u754c',
        },
        qualityScore: 0.8,
        categories: ['special'],
        sourceCount: 1,
      },
    ];
    const result = await new JsonExporter().export(specialEntities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const json = result.data as string;
    const parsed = JSON.parse(json);
    expect(parsed[0].data.name).toBe('Quote "test" and back\\slash');
    expect(parsed[0].data.description).toBe('Line1\nLine2\ttab');
    expect(parsed[0].data.unicode).toBe('\u00e9\u00e8\u00ea \u2603 \ud83d\ude00 \u4e16\u754c');
    // Round-trip: re-stringify should match original
    expect(JSON.stringify(parsed, null, 2)).toBe(json);
  });

  it('handles nested object and array fields', async () => {
    const nestedEntities = [
      {
        mergedData: {
          name: 'Nested',
          details: { color: 'red', sizes: [1, 2, 3] },
          tags: ['a', 'b', 'c'],
          meta: { nested: { deep: true } },
        },
        qualityScore: 0.95,
        categories: ['nested'],
        sourceCount: 1,
      },
    ];
    const result = await new JsonExporter().export(nestedEntities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].data.details).toEqual({ color: 'red', sizes: [1, 2, 3] });
    expect(parsed[0].data.tags).toEqual(['a', 'b', 'c']);
    expect(parsed[0].data.meta.nested.deep).toBe(true);
  });

  it('produces valid JSON for empty dataset', async () => {
    const result = await new JsonExporter().export([], schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect(result.entityCount).toBe(0);
    const parsed = JSON.parse(result.data as string);
    expect(parsed).toEqual([]);
  });

  it('handles very large field values without truncation', async () => {
    const largeValue = 'x'.repeat(10 * 1024); // 10KB string
    const largeEntities = [
      {
        mergedData: { name: largeValue, price: 1 },
        qualityScore: 0.7,
        categories: ['large'],
        sourceCount: 1,
      },
    ];
    const result = await new JsonExporter().export(largeEntities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].data.name).toHaveLength(10 * 1024);
    expect(parsed[0].data.name).toBe(largeValue);
  });

  it('handles null and undefined values in data', async () => {
    const nullEntities = [
      {
        mergedData: { name: 'Test', price: null, description: undefined },
        qualityScore: 0.5,
        categories: [],
        sourceCount: 1,
      },
    ];
    const result = await new JsonExporter().export(nullEntities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const json = result.data as string;
    const parsed = JSON.parse(json);
    expect(parsed[0].data.name).toBe('Test');
    expect(parsed[0].data.price).toBeNull();
    // undefined fields are omitted by JSON.stringify
    expect('description' in parsed[0].data).toBe(false);
    // Verify the JSON string itself does not contain the literal "undefined"
    expect(json).not.toContain('undefined');
  });
});
