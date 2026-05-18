import { describe, it, expect } from 'vitest';
import { generateDocumentation } from '../../../src/exporters/documentation-generator.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { Entity } from '@spatula/shared';

const mockSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price in USD', type: 'number', required: false },
    { name: 'brand', description: 'Brand name', type: 'string', required: false },
  ],
  fieldAliases: [
    {
      canonicalName: 'name',
      aliases: [{ name: 'title', sources: ['site-a.com'], occurrences: 3 }],
      mergedAt: new Date(),
      reasoning: 'synonym',
    },
  ],
  createdAt: new Date(),
  parentVersion: null,
};

const mockEntities: Entity[] = [
  {
    id: 'e1',
    jobId: 'j1',
    mergedData: { name: 'Widget A', price: 10, brand: 'Acme' },
    categories: [],
    qualityScore: 0.9,
    createdAt: '',
    sourceCount: 2,
  },
  {
    id: 'e2',
    jobId: 'j1',
    mergedData: { name: 'Widget B', price: 20, brand: 'Acme' },
    categories: [],
    qualityScore: 0.8,
    createdAt: '',
    sourceCount: 1,
  },
  {
    id: 'e3',
    jobId: 'j1',
    mergedData: { name: 'Widget C', price: null, brand: null },
    categories: [],
    qualityScore: 0.7,
    createdAt: '',
    sourceCount: 1,
  },
] as any;

describe('generateDocumentation', () => {
  it('returns correct field count', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    expect(doc.fields).toHaveLength(3);
  });

  it('computes fillRate correctly', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.stats.fillRate).toBe(1);
    const brandField = doc.fields.find((f) => f.name === 'brand')!;
    expect(brandField.stats.fillRate).toBeCloseTo(2 / 3);
  });

  it('computes uniqueCount correctly', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const brandField = doc.fields.find((f) => f.name === 'brand')!;
    expect(brandField.stats.uniqueCount).toBe(1); // only 'Acme'
  });

  it('computes min/max for numeric fields', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const priceField = doc.fields.find((f) => f.name === 'price')!;
    expect(priceField.stats.min).toBe(10);
    expect(priceField.stats.max).toBe(20);
  });

  it('provides sampleValues (up to 5)', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.stats.sampleValues.length).toBeLessThanOrEqual(5);
    expect(nameField.stats.sampleValues).toContain('Widget A');
  });

  it('includes field aliases', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.aliases).toContain('title');
  });

  it('includes field description and type', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.description).toBe('Product name');
    expect(nameField.type).toBe('string');
    expect(nameField.required).toBe(true);
  });

  it('sets sampled flag when entities exceed 1000', () => {
    const largeEntities = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${i}`,
      jobId: 'j1',
      mergedData: { name: `Item ${i}` },
      categories: [],
      qualityScore: 0.5,
      createdAt: '',
      sourceCount: 1,
    })) as any;
    const doc = generateDocumentation(mockSchema, largeEntities, 'j1');
    expect(doc.sampled).toBe(true);
    expect(doc.sampleSize).toBe(1000);
  });

  it('handles empty entity list', () => {
    const doc = generateDocumentation(mockSchema, [], 'j1');
    expect(doc.entityCount).toBe(0);
    expect(doc.fields[0].stats.fillRate).toBe(0);
  });
});
