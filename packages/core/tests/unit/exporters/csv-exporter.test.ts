import { describe, it, expect } from 'vitest';
import { CsvExporter } from '../../../src/exporters/csv-exporter.js';
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
  { mergedData: { name: 'Product A', price: 10 } },
  { mergedData: { name: 'Product B', price: 20 } },
];

describe('CsvExporter', () => {
  it('has format csv', () => {
    const exporter = new CsvExporter();
    expect(exporter.format).toBe('csv');
  });

  it('exports entities as CSV', async () => {
    const exporter = new CsvExporter();
    const result = await exporter.export(entities, schema, {
      format: 'csv', includeProvenance: false, includeDocumentation: false,
    });
    expect(result.entityCount).toBe(2);
    expect(result.format).toBe('csv');
    const csv = result.data as string;
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,price');
    expect(lines).toHaveLength(3);
  });

  it('uses schema field order for columns', async () => {
    const exporter = new CsvExporter();
    const result = await exporter.export(entities, schema, {
      format: 'csv', includeProvenance: false, includeDocumentation: false,
    });
    expect((result.data as string).startsWith('name,price')).toBe(true);
  });
});
