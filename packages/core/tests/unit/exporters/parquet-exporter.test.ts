import { describe, it, expect } from 'vitest';
import { ParquetExporter } from '../../../src/exporters/parquet-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'number', required: false },
    { name: 'active', description: 'Active', type: 'boolean', required: true },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  {
    mergedData: { name: 'Widget', price: 9.99, active: true },
    qualityScore: 0.9,
    categories: [],
    sourceCount: 1,
  },
  {
    mergedData: { name: 'Gadget', price: null, active: false },
    qualityScore: 0.8,
    categories: [],
    sourceCount: 1,
  },
];

describe('ParquetExporter', () => {
  it('exports entities to valid Parquet binary', async () => {
    const exporter = new ParquetExporter();
    const result = await exporter.export(entities, schema, {
      format: 'parquet',
      includeProvenance: false,
    });

    expect(result.format).toBe('parquet');
    expect(result.entityCount).toBe(2);
    expect(result.binaryData).toBeInstanceOf(Uint8Array);
    expect(result.binaryData!.byteLength).toBeGreaterThan(0);

    // Verify it's valid Parquet by checking the magic bytes
    // Parquet files start with "PAR1" (bytes 0x50, 0x41, 0x52, 0x31)
    const magic = new TextDecoder().decode(result.binaryData!.slice(0, 4));
    expect(magic).toBe('PAR1');
  });

  it('has format parquet', () => {
    expect(new ParquetExporter().format).toBe('parquet');
  });

  it('handles empty entity list', async () => {
    const exporter = new ParquetExporter();
    const result = await exporter.export([], schema, {
      format: 'parquet',
      includeProvenance: false,
    });

    expect(result.format).toBe('parquet');
    expect(result.entityCount).toBe(0);
    expect(result.binaryData).toBeInstanceOf(Uint8Array);
    // Even an empty Parquet file has the PAR1 magic + footer
    expect(result.binaryData!.byteLength).toBeGreaterThan(0);
  });

  it('serializes nested objects as JSON strings', async () => {
    const nestedSchema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'name', description: 'Name', type: 'string', required: true },
        { name: 'metadata', description: 'Metadata', type: 'object', required: false },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };

    const nestedEntities = [
      { mergedData: { name: 'Widget', metadata: { color: 'red', size: 5 } } },
    ];

    const exporter = new ParquetExporter();
    const result = await exporter.export(nestedEntities, nestedSchema, {
      format: 'parquet',
      includeProvenance: false,
    });

    expect(result.binaryData).toBeInstanceOf(Uint8Array);
    expect(result.binaryData!.byteLength).toBeGreaterThan(0);
  });
});
