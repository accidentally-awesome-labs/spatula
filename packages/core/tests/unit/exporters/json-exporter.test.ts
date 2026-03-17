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
      format: 'json', includeProvenance: false, includeDocumentation: false,
    });
    expect(result.entityCount).toBe(1);
    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.data as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].data.name).toBe('A');
    expect(parsed[0].qualityScore).toBe(0.9);
  });

  it('includes provenance when requested', async () => {
    const withProv = [{
      mergedData: { name: 'A' }, qualityScore: 0.9, categories: [], sourceCount: 1,
      provenance: { name: { provenanceType: 'extracted' } },
      sources: [{ extractionId: 'ext-1', matchConfidence: 0.9 }],
    }];
    const result = await new JsonExporter().export(withProv, schema, {
      format: 'json', includeProvenance: true, includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeDefined();
    expect(parsed[0].sources).toBeDefined();
  });

  it('excludes provenance by default', async () => {
    const result = await new JsonExporter().export(entities, schema, {
      format: 'json', includeProvenance: false, includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeUndefined();
  });
});
