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
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
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
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect((result.data as string).startsWith('name,price')).toBe(true);
  });

  it('escapes special characters per RFC 4180', async () => {
    const specialEntities = [
      { mergedData: { name: 'Has, comma', price: 10 } },
      { mergedData: { name: 'Has "quotes"', price: 20 } },
      { mergedData: { name: 'Has\nnewline', price: 30 } },
    ];
    const exporter = new CsvExporter();
    const result = await exporter.export(specialEntities, schema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const csv = result.data as string;
    const lines = csv.split('\n');
    // "Has, comma" should be quoted
    expect(lines[1]).toBe('"Has, comma",10');
    // "Has "quotes"" should have doubled quotes
    expect(lines[2]).toBe('"Has ""quotes""",20');
    // "Has\nnewline" should be quoted (the newline is embedded inside quotes)
    // The split will break this across lines, so check the raw csv instead
    expect(csv).toContain('"Has\nnewline"');
  });

  it('outputs header row only for empty dataset', async () => {
    const exporter = new CsvExporter();
    const result = await exporter.export([], schema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect(result.entityCount).toBe(0);
    const csv = result.data as string;
    expect(csv).toBe('name,price');
  });

  it('renders null and undefined values as empty cells', async () => {
    const nullEntities = [
      { mergedData: { name: 'Test', price: null } },
      { mergedData: { name: undefined, price: 42 } },
    ];
    const exporter = new CsvExporter();
    const result = await exporter.export(nullEntities, schema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const csv = result.data as string;
    const lines = csv.split('\n');
    // null price should be empty, not "null"
    expect(lines[1]).toBe('Test,');
    // undefined name should be empty, not "undefined"
    expect(lines[2]).toBe(',42');
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('maintains consistent column ordering across entities with different fields', async () => {
    const mixedSchema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'name', description: 'Name', type: 'string', required: true },
        { name: 'price', description: 'Price', type: 'number', required: false },
        { name: 'color', description: 'Color', type: 'string', required: false },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const mixedEntities = [
      { mergedData: { name: 'A', price: 10 } }, // missing color
      { mergedData: { name: 'B', color: 'red' } }, // missing price
      { mergedData: { name: 'C', price: 30, color: 'blue' } }, // all fields
    ];
    const exporter = new CsvExporter();
    const result = await exporter.export(mixedEntities, mixedSchema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const csv = result.data as string;
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,price,color');
    expect(lines[1]).toBe('A,10,'); // missing color => empty
    expect(lines[2]).toBe('B,,red'); // missing price => empty
    expect(lines[3]).toBe('C,30,blue'); // all present
  });

  it('handles unicode in field names and values', async () => {
    const unicodeSchema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'nombre', description: 'Nombre', type: 'string', required: true },
        { name: 'precio', description: 'Precio', type: 'number', required: false },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    };
    const unicodeEntities = [
      { mergedData: { nombre: '\u00e9l\u00e8ve caf\u00e9', precio: 10 } },
      { mergedData: { nombre: '\u4e16\u754c \ud83c\udf0d', precio: 20 } },
      { mergedData: { nombre: '\u00fc\u00f6\u00e4\u00df', precio: 30 } },
    ];
    const exporter = new CsvExporter();
    const result = await exporter.export(unicodeEntities, unicodeSchema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const csv = result.data as string;
    const lines = csv.split('\n');
    expect(lines[0]).toBe('nombre,precio');
    expect(lines[1]).toBe('\u00e9l\u00e8ve caf\u00e9,10');
    expect(lines[2]).toBe('\u4e16\u754c \ud83c\udf0d,20');
    expect(lines[3]).toBe('\u00fc\u00f6\u00e4\u00df,30');
  });
});
