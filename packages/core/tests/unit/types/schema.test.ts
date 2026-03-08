import { describe, it, expect } from 'vitest';
import {
  FieldDefinition,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from '../../../src/types/schema.js';

describe('FieldDefinition', () => {
  it('parses a simple string field', () => {
    const result = FieldDefinition.parse({
      name: 'product_name',
      description: 'Name of the product',
      type: 'string',
    });
    expect(result.name).toBe('product_name');
    expect(result.required).toBe(false); // default
  });

  it('parses a required currency field with normalization', () => {
    const result = FieldDefinition.parse({
      name: 'price',
      description: 'Product price',
      type: 'currency',
      required: true,
      normalization: {
        type: 'currency',
        config: { targetCurrency: 'USD' },
      },
    });
    expect(result.required).toBe(true);
    expect(result.normalization?.type).toBe('currency');
  });

  it('parses an enum field with values', () => {
    const result = FieldDefinition.parse({
      name: 'device_type',
      description: 'Type of audio device',
      type: 'enum',
      enumValues: ['headphone', 'iem', 'dac', 'amplifier'],
    });
    expect(result.enumValues).toHaveLength(4);
  });

  it('parses a nested object field', () => {
    const result = FieldDefinition.parse({
      name: 'specs',
      description: 'Technical specifications',
      type: 'object',
      objectFields: [
        { name: 'impedance', description: 'Impedance in ohms', type: 'number' },
        { name: 'weight', description: 'Weight', type: 'string' },
      ],
    });
    expect(result.objectFields).toHaveLength(2);
  });

  it('parses an array field', () => {
    const result = FieldDefinition.parse({
      name: 'images',
      description: 'Product image URLs',
      type: 'array',
      arrayItemType: {
        name: 'image_url',
        description: 'Single image URL',
        type: 'url',
      },
    });
    expect(result.arrayItemType?.type).toBe('url');
  });

  it('rejects invalid type', () => {
    expect(() => FieldDefinition.parse({ name: 'x', description: 'x', type: 'invalid' })).toThrow();
  });
});

describe('FieldRelevance', () => {
  it('parses a universal required field', () => {
    const result = FieldRelevance.parse({
      globalFrequency: 0.95,
      categoryBreakdown: [],
      classification: 'universal_required',
      applicableCategories: null,
    });
    expect(result.classification).toBe('universal_required');
  });

  it('parses a categorical field with breakdown', () => {
    const result = FieldRelevance.parse({
      globalFrequency: 0.4,
      categoryBreakdown: [
        { category: 'headphone', frequency: 0.98, sampleSize: 63 },
        { category: 'iem', frequency: 0.95, sampleSize: 28 },
      ],
      classification: 'categorical_required',
      applicableCategories: ['headphone', 'iem'],
    });
    expect(result.categoryBreakdown).toHaveLength(2);
    expect(result.applicableCategories).toContain('headphone');
  });
});

describe('FieldAlias', () => {
  it('parses a field alias mapping', () => {
    const result = FieldAlias.parse({
      canonicalName: 'price',
      aliases: [
        { name: 'retail_price', sources: ['amazon.com'], occurrences: 47 },
        { name: 'msrp', sources: ['sennheiser.com'], occurrences: 12 },
      ],
      mergedAt: new Date().toISOString(),
      reasoning: 'Both represent product selling price',
    });
    expect(result.aliases).toHaveLength(2);
  });
});

describe('SchemaDefinition', () => {
  it('parses a complete schema definition', () => {
    const result = SchemaDefinition.parse({
      version: 3,
      fields: [
        { name: 'name', description: 'Product name', type: 'string', required: true },
        { name: 'price', description: 'Price', type: 'currency' },
      ],
      fieldAliases: [],
      createdAt: new Date().toISOString(),
      parentVersion: 2,
    });
    expect(result.version).toBe(3);
    expect(result.fields).toHaveLength(2);
    expect(result.parentVersion).toBe(2);
  });

  it('allows null parentVersion for initial schema', () => {
    const result = SchemaDefinition.parse({
      version: 1,
      fields: [],
      fieldAliases: [],
      createdAt: new Date().toISOString(),
      parentVersion: null,
    });
    expect(result.parentVersion).toBeNull();
  });
});
