import { describe, it, expect } from 'vitest';
import { schemaToPrompt, schemaToJsonSchema } from '../../../src/extraction/schema-to-prompt.js';
import type { FieldDefinitionOutput } from '../../../src/types/schema.js';

describe('schemaToPrompt', () => {
  it('formats a simple string field', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'title', description: 'Product title', type: 'string', required: true },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('title');
    expect(prompt).toContain('string');
    expect(prompt).toContain('REQUIRED');
    expect(prompt).toContain('Product title');
  });

  it('marks optional fields without REQUIRED', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'notes', description: 'Extra notes', type: 'string', required: false },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('notes');
    expect(prompt).not.toContain('REQUIRED');
  });

  it('formats enum field with allowed values', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'category',
        description: 'Product category',
        type: 'enum',
        required: true,
        enumValues: ['headphones', 'speakers', 'amplifiers'],
      },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('headphones');
    expect(prompt).toContain('speakers');
    expect(prompt).toContain('amplifiers');
  });

  it('formats nested object fields', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'specs',
        description: 'Technical specifications',
        type: 'object',
        required: false,
        objectFields: [
          { name: 'weight', description: 'Weight in grams', type: 'number', required: false },
          { name: 'color', description: 'Product color', type: 'string', required: false },
        ],
      },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('specs');
    expect(prompt).toContain('weight');
    expect(prompt).toContain('color');
  });

  it('formats array field with item type', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'features',
        description: 'Product features',
        type: 'array',
        required: false,
        arrayItemType: { name: 'feature', description: 'A feature', type: 'string', required: false },
      },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('features');
    expect(prompt).toContain('array');
    expect(prompt).toContain('string');
  });

  it('handles multiple fields', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'name', description: 'Name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'currency', required: false },
      { name: 'url', description: 'URL', type: 'url', required: false },
    ];
    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('name');
    expect(prompt).toContain('price');
    expect(prompt).toContain('url');
  });
});

describe('schemaToJsonSchema', () => {
  it('generates valid JSON schema for simple fields', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ];
    const schema = schemaToJsonSchema(fields);
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect((schema.properties as Record<string, unknown>).title).toBeDefined();
    expect((schema.properties as Record<string, unknown>).price).toBeDefined();
    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('price');
  });

  it('maps currency type to object with amount and currency', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'price', description: 'Price', type: 'currency', required: false },
    ];
    const schema = schemaToJsonSchema(fields);
    const priceProp = (schema.properties as Record<string, Record<string, unknown>>).price;
    expect(priceProp.type).toBe('object');
    expect(priceProp.properties).toBeDefined();
  });

  it('maps enum type to string with enum values', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'status',
        description: 'Status',
        type: 'enum',
        required: false,
        enumValues: ['active', 'inactive'],
      },
    ];
    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).status;
    expect(prop.type).toBe('string');
    expect(prop.enum).toEqual(['active', 'inactive']);
  });

  it('maps object type with nested properties', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'dimensions',
        description: 'Dimensions',
        type: 'object',
        required: false,
        objectFields: [
          { name: 'width', description: 'Width', type: 'number', required: false },
          { name: 'height', description: 'Height', type: 'number', required: false },
        ],
      },
    ];
    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).dimensions;
    expect(prop.type).toBe('object');
    expect(prop.properties).toBeDefined();
  });

  it('maps array type with item schema', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'tags',
        description: 'Tags',
        type: 'array',
        required: false,
        arrayItemType: { name: 'tag', description: 'A tag', type: 'string', required: false },
      },
    ];
    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).tags;
    expect(prop.type).toBe('array');
    expect(prop.items).toBeDefined();
  });
});
