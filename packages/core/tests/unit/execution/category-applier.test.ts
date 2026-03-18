import { describe, it, expect } from 'vitest';
import { applyCategoryActions } from '../../../src/execution/category-applier.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.9,
  };
}

function makeSchema(overrides: Partial<SchemaDefinition> = {}): SchemaDefinition {
  return {
    version: 1,
    fields: [
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ],
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
    ...overrides,
  };
}

describe('applyCategoryActions', () => {
  describe('define_category', () => {
    it('adds categories to result metadata', () => {
      const schema = makeSchema();
      const action: PipelineAction = {
        ...baseAction(),
        type: 'define_category',
        payload: {
          categoryField: 'product_type',
          categories: [
            { name: 'electronics', description: 'Electronic devices', matchCriteria: 'tech products' },
            { name: 'clothing', description: 'Apparel', matchCriteria: 'wearable items' },
          ],
        },
      };

      const result = applyCategoryActions(schema, [action]);

      expect(result.categories).toBeDefined();
      expect(result.categories!.categoryField).toBe('product_type');
      expect(result.categories!.definitions).toHaveLength(2);
      expect(result.categories!.definitions[0].name).toBe('electronics');
    });

    it('overwrites previous category definitions', () => {
      const schema = makeSchema();
      const actions: PipelineAction[] = [
        {
          ...baseAction(),
          type: 'define_category',
          payload: {
            categoryField: 'type_a',
            categories: [{ name: 'old', description: 'Old', matchCriteria: 'old' }],
          },
        },
        {
          ...baseAction(),
          type: 'define_category',
          payload: {
            categoryField: 'type_b',
            categories: [{ name: 'new', description: 'New', matchCriteria: 'new' }],
          },
        },
      ];

      const result = applyCategoryActions(schema, actions);
      expect(result.categories!.categoryField).toBe('type_b');
    });
  });

  describe('assign_category_fields', () => {
    it('records field assignments per category', () => {
      const schema = makeSchema();
      const action: PipelineAction = {
        ...baseAction(),
        type: 'assign_category_fields',
        payload: {
          category: 'electronics',
          requiredFields: ['title', 'price'],
          optionalFields: ['warranty'],
        },
      };

      const result = applyCategoryActions(schema, [action]);

      expect(result.categoryFieldAssignments).toBeDefined();
      expect(result.categoryFieldAssignments!['electronics']).toEqual({
        requiredFields: ['title', 'price'],
        optionalFields: ['warranty'],
      });
    });

    it('accumulates assignments for multiple categories', () => {
      const schema = makeSchema();
      const actions: PipelineAction[] = [
        {
          ...baseAction(),
          type: 'assign_category_fields',
          payload: {
            category: 'electronics',
            requiredFields: ['title'],
            optionalFields: [],
          },
        },
        {
          ...baseAction(),
          type: 'assign_category_fields',
          payload: {
            category: 'clothing',
            requiredFields: ['size'],
            optionalFields: ['color'],
          },
        },
      ];

      const result = applyCategoryActions(schema, actions);
      expect(Object.keys(result.categoryFieldAssignments!)).toHaveLength(2);
    });
  });

  it('skips non-category action types', () => {
    const schema = makeSchema();
    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: { name: 'x', description: 'x', type: 'string', required: false },
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = applyCategoryActions(schema, [action]);
    expect(result.categories).toBeUndefined();
    expect(result.categoryFieldAssignments).toBeUndefined();
  });
});
