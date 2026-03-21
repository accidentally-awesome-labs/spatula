import { describe, it, expect } from 'vitest';
import { mapSchema } from '../../../src/exporters/column-mapper.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const testSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'title', description: 'Title', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
    { name: 'rating', description: 'Rating', type: 'number', required: false },
    { name: 'available', description: 'In stock', type: 'boolean', required: true },
    { name: 'link', description: 'URL', type: 'url', required: false },
    { name: 'category', description: 'Cat', type: 'enum', required: false, enumValues: ['A', 'B'] },
    { name: 'tags', description: 'Tags', type: 'array', required: false },
    { name: 'metadata', description: 'Meta', type: 'object', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

describe('mapSchema', () => {
  it('maps all 8 field types for sqlite', () => {
    const cols = mapSchema(testSchema, 'sqlite');
    expect(cols).toHaveLength(8);
    expect(cols.find((c) => c.name === 'title')).toEqual({ name: 'title', nativeType: 'TEXT', nullable: false });
    expect(cols.find((c) => c.name === 'price')).toEqual({ name: 'price', nativeType: 'REAL', nullable: true });
    expect(cols.find((c) => c.name === 'available')).toEqual({ name: 'available', nativeType: 'INTEGER', nullable: false });
    expect(cols.find((c) => c.name === 'tags')).toEqual({ name: 'tags', nativeType: 'TEXT', nullable: true });
  });

  it('maps all 8 field types for duckdb', () => {
    const cols = mapSchema(testSchema, 'duckdb');
    expect(cols.find((c) => c.name === 'price')?.nativeType).toBe('DECIMAL(19,4)');
    expect(cols.find((c) => c.name === 'rating')?.nativeType).toBe('DOUBLE');
    expect(cols.find((c) => c.name === 'available')?.nativeType).toBe('BOOLEAN');
  });

  it('maps all 8 field types for parquet', () => {
    const cols = mapSchema(testSchema, 'parquet');
    expect(cols.find((c) => c.name === 'title')?.nativeType).toBe('UTF8');
    expect(cols.find((c) => c.name === 'available')?.nativeType).toBe('BOOLEAN');
    expect(cols.find((c) => c.name === 'rating')?.nativeType).toBe('DOUBLE');
  });

  it('handles required fields as non-nullable', () => {
    const cols = mapSchema(testSchema, 'sqlite');
    expect(cols.find((c) => c.name === 'title')?.nullable).toBe(false);
    expect(cols.find((c) => c.name === 'available')?.nullable).toBe(false);
    expect(cols.find((c) => c.name === 'price')?.nullable).toBe(true);
  });
});
