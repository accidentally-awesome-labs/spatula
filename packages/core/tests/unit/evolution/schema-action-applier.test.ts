import { describe, it, expect } from 'vitest';
import { generateId } from '@spatula/shared';
import { applySchemaActions } from '../../../src/evolution/schema-action-applier.js';
import type { SchemaDefinition, FieldDefinition } from '../../../src/types/schema.js';
import type { PipelineAction } from '../../../src/types/actions.js';

/** Helper: create a base PipelineAction with required fields. */
function baseAction(
  overrides: Partial<PipelineAction> = {},
): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'schema_evolution',
    reasoning: 'test reasoning',
    confidence: 0.9,
    ...overrides,
  };
}

/** Helper: create a minimal SchemaDefinition. */
function makeSchema(
  fields: FieldDefinition[] = [],
  overrides: Partial<SchemaDefinition> = {},
): SchemaDefinition {
  return {
    version: 1,
    fields,
    fieldAliases: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    parentVersion: null,
    ...overrides,
  };
}

/** Helper: create a minimal FieldDefinition. */
function makeField(name: string, overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    name,
    description: `The ${name} field`,
    type: 'string',
    required: false,
    ...overrides,
  };
}

describe('applySchemaActions', () => {
  // --- empty actions ---

  it('returns unchanged schema (same version) when actions array is empty', () => {
    const schema = makeSchema([makeField('title')]);
    const result = applySchemaActions(schema, []);

    expect(result).toBe(schema); // same reference
    expect(result.version).toBe(1);
  });

  // --- add_field ---

  it('add_field: adds new field and increments version', () => {
    const schema = makeSchema([makeField('title')]);
    const newField = makeField('price', { type: 'number', required: true });

    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: newField,
        relevance: {
          globalFrequency: 0.8,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[1].name).toBe('price');
    expect(result.fields[1].type).toBe('number');
    expect(result.fields[1].required).toBe(true);
    expect(result.createdAt).not.toEqual(schema.createdAt);
  });

  it('add_field: skips duplicate field name', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: makeField('title'),
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = applySchemaActions(schema, [action]);

    // No action was applied, so the schema should be returned unchanged
    expect(result.version).toBe(1);
    expect(result.fields).toHaveLength(1);
  });

  it('add_field: inserts after specified field when insertAfter is set', () => {
    const schema = makeSchema([makeField('title'), makeField('description')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: makeField('price', { type: 'number' }),
        relevance: {
          globalFrequency: 0.8,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
        insertAfter: 'title',
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.fields).toHaveLength(3);
    expect(result.fields[0].name).toBe('title');
    expect(result.fields[1].name).toBe('price');
    expect(result.fields[2].name).toBe('description');
  });

  // --- remove_field ---

  it('remove_field: removes existing field', () => {
    const schema = makeSchema([makeField('title'), makeField('price'), makeField('description')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'remove_field',
      payload: {
        fieldName: 'price',
        reason: 'irrelevant',
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    expect(result.fields).toHaveLength(2);
    expect(result.fields.map((f) => f.name)).toEqual(['title', 'description']);
  });

  it('remove_field: skips non-existent field gracefully', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'remove_field',
      payload: {
        fieldName: 'nonexistent',
        reason: 'irrelevant',
      },
    };

    const result = applySchemaActions(schema, [action]);

    // No action was applied, so the schema should be returned unchanged
    expect(result.version).toBe(1);
    expect(result.fields).toHaveLength(1);
  });

  // --- modify_field ---

  it('modify_field: updates type and required', () => {
    const schema = makeSchema([makeField('price', { type: 'string', required: false })]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'modify_field',
      payload: {
        fieldName: 'price',
        changes: {
          type: 'number',
          required: true,
        },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields[0].type).toBe('number');
    expect(result.fields[0].required).toBe(true);
    // Original name and description should be preserved
    expect(result.fields[0].name).toBe('price');
    expect(result.fields[0].description).toBe('The price field');
  });

  it('modify_field: updates description and enumValues', () => {
    const schema = makeSchema([makeField('status', { type: 'enum', enumValues: ['active'] })]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'modify_field',
      payload: {
        fieldName: 'status',
        changes: {
          description: 'The item status',
          enumValues: ['active', 'inactive', 'archived'],
        },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields[0].description).toBe('The item status');
    expect(result.fields[0].enumValues).toEqual(['active', 'inactive', 'archived']);
  });

  it('modify_field: skips non-existent field gracefully', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'modify_field',
      payload: {
        fieldName: 'nonexistent',
        changes: { type: 'number' },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(1);
  });

  // --- rename_field ---

  it('rename_field: changes field name', () => {
    const schema = makeSchema([makeField('product_name', { description: 'Name of the product' })]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'rename_field',
      payload: {
        currentName: 'product_name',
        newName: 'name',
        updateExistingData: true,
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('name');
    // Other properties preserved
    expect(result.fields[0].description).toBe('Name of the product');
  });

  it('rename_field: skips non-existent field gracefully', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'rename_field',
      payload: {
        currentName: 'nonexistent',
        newName: 'something',
        updateExistingData: true,
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(1);
  });

  // --- merge_fields ---

  it('merge_fields: removes aliases, adds canonical, records FieldAlias', () => {
    const schema = makeSchema([
      makeField('product_name'),
      makeField('item_name'),
      makeField('title'),
      makeField('price'),
    ]);

    const canonicalDefinition = makeField('name', {
      description: 'Canonical product name',
      required: true,
    });

    const action: PipelineAction = {
      ...baseAction(),
      type: 'merge_fields',
      payload: {
        canonicalName: 'name',
        aliasNames: ['product_name', 'item_name', 'title'],
        canonicalDefinition,
        valueMappings: {},
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);

    // Alias fields removed, canonical added, price kept
    expect(result.fields).toHaveLength(2);
    expect(result.fields.map((f) => f.name)).toEqual(['price', 'name']);

    // FieldAlias recorded
    expect(result.fieldAliases).toHaveLength(1);
    expect(result.fieldAliases[0].canonicalName).toBe('name');
    expect(result.fieldAliases[0].aliases).toHaveLength(3);
    expect(result.fieldAliases[0].aliases.map((a) => a.name)).toEqual([
      'product_name',
      'item_name',
      'title',
    ]);
    expect(result.fieldAliases[0].reasoning).toBe('test reasoning');
    expect(result.fieldAliases[0].mergedAt).toBeInstanceOf(Date);
  });

  it('merge_fields: does not duplicate canonical field if it already exists', () => {
    const schema = makeSchema([
      makeField('name', { description: 'Original name field' }),
      makeField('title'),
    ]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'merge_fields',
      payload: {
        canonicalName: 'name',
        aliasNames: ['title'],
        canonicalDefinition: makeField('name', { description: 'Merged name' }),
        valueMappings: {},
      },
    };

    const result = applySchemaActions(schema, [action]);

    // 'title' removed, 'name' already existed so not re-added
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('name');
  });

  // --- set_normalization_rule ---

  it('set_normalization_rule: attaches rule to field', () => {
    const schema = makeSchema([makeField('price', { type: 'currency' })]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'set_normalization_rule',
      payload: {
        fieldName: 'price',
        rule: {
          type: 'currency',
          config: {
            targetCurrency: 'USD',
            decimalPlaces: 2,
          },
        },
        examples: [
          { before: '$19.99', after: 19.99 },
          { before: '15 EUR', after: 15.0 },
        ],
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields[0].normalization).toEqual({
      type: 'currency',
      config: {
        targetCurrency: 'USD',
        decimalPlaces: 2,
      },
    });
  });

  it('set_normalization_rule: skips non-existent field gracefully', () => {
    const schema = makeSchema([makeField('price')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'set_normalization_rule',
      payload: {
        fieldName: 'nonexistent',
        rule: {
          type: 'text',
          config: { casing: 'lower', trim: true, collapseWhitespace: true },
        },
        examples: [],
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(1);
  });

  // --- update_enum_map ---

  it('update_enum_map: updates synonym map and adds new canonical values', () => {
    const schema = makeSchema([
      makeField('color', {
        type: 'enum',
        enumValues: ['red', 'blue'],
        normalization: {
          type: 'enum',
          config: {
            canonicalValues: ['red', 'blue'],
            synonymMap: { crimson: 'red', navy: 'blue' },
          },
        },
      }),
    ]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'update_enum_map',
      payload: {
        fieldName: 'color',
        additions: { scarlet: 'red', azure: 'blue', forest: 'green' },
        newCanonicalValues: ['green'],
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    const norm = result.fields[0].normalization;
    expect(norm?.type).toBe('enum');
    if (norm?.type === 'enum') {
      expect(norm.config.synonymMap).toEqual({
        crimson: 'red',
        navy: 'blue',
        scarlet: 'red',
        azure: 'blue',
        forest: 'green',
      });
      expect(norm.config.canonicalValues).toEqual(['red', 'blue', 'green']);
    }
  });

  it('update_enum_map: skips field without enum normalization', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'update_enum_map',
      payload: {
        fieldName: 'title',
        additions: { foo: 'bar' },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(1);
  });

  // --- split_field ---

  it('split_field: removes source and inserts target fields at same position', () => {
    const schema = makeSchema([
      makeField('name'),
      makeField('full_address', { description: 'Full street address' }),
      makeField('price'),
    ]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'split_field',
      payload: {
        sourceField: 'full_address',
        targetFields: [
          makeField('street', { description: 'Street name and number' }),
          makeField('city', { description: 'City name' }),
          makeField('zip', { description: 'ZIP/postal code' }),
        ],
        splitLogic: 'Parse address components',
        examples: [
          {
            sourceValue: '123 Main St, Springfield, 62701',
            targetValues: { street: '123 Main St', city: 'Springfield', zip: '62701' },
          },
        ],
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields).toHaveLength(5); // name + street + city + zip + price
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'street', 'city', 'zip', 'price']);
  });

  it('split_field: skips when source field not found', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'split_field',
      payload: {
        sourceField: 'nonexistent',
        targetFields: [makeField('a'), makeField('b')],
        splitLogic: 'test',
        examples: [],
      },
    };

    const result = applySchemaActions(schema, [action]);
    expect(result.version).toBe(1);
  });

  // --- group_fields ---

  it('group_fields: removes source fields and creates new object field', () => {
    const schema = makeSchema([
      makeField('name'),
      makeField('street'),
      makeField('city'),
      makeField('zip'),
      makeField('price'),
    ]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'group_fields',
      payload: {
        targetFieldName: 'address',
        targetFieldType: 'object',
        sourceFields: ['street', 'city', 'zip'],
        mapping: { street: 'street', city: 'city', zip: 'zipCode' },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields).toHaveLength(3); // name + address + price
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'address', 'price']);

    const addressField = result.fields.find((f) => f.name === 'address')!;
    expect(addressField.type).toBe('object');
    expect(addressField.objectFields).toHaveLength(3);
    expect(addressField.objectFields!.map((f) => f.name)).toEqual(['street', 'city', 'zipCode']);
  });

  it('group_fields: handles partial matches (only some source fields exist)', () => {
    const schema = makeSchema([makeField('name'), makeField('street'), makeField('price')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'group_fields',
      payload: {
        targetFieldName: 'address',
        targetFieldType: 'object',
        sourceFields: ['street', 'city', 'zip'], // city and zip don't exist
        mapping: { street: 'street', city: 'city', zip: 'zipCode' },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields).toHaveLength(3); // name + address + price
    const addressField = result.fields.find((f) => f.name === 'address')!;
    expect(addressField.objectFields).toHaveLength(1); // only 'street' matched
    expect(addressField.objectFields![0].name).toBe('street');
  });

  it('group_fields: skips when no source fields exist', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'group_fields',
      payload: {
        targetFieldName: 'address',
        targetFieldType: 'object',
        sourceFields: ['nonexistent_a', 'nonexistent_b'],
        mapping: { nonexistent_a: 'a', nonexistent_b: 'b' },
      },
    };

    const result = applySchemaActions(schema, [action]);
    expect(result.version).toBe(1);
  });

  // --- unsupported action types ---

  it('skips unsupported action types silently', () => {
    const schema = makeSchema([makeField('title')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'classify_page',
      payload: {
        pageId: generateId(),
        classification: 'single_entry',
        extractionStrategy: 'full_page',
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(1);
  });

  // --- multiple actions ---

  it('applies multiple actions sequentially and increments version once', () => {
    const schema = makeSchema([makeField('title')]);

    const actions: PipelineAction[] = [
      {
        ...baseAction(),
        type: 'add_field',
        payload: {
          field: makeField('price', { type: 'number' }),
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      },
      {
        ...baseAction(),
        type: 'modify_field',
        payload: {
          fieldName: 'title',
          changes: { required: true },
        },
      },
      {
        ...baseAction(),
        type: 'remove_field',
        payload: {
          fieldName: 'price',
          reason: 'irrelevant',
        },
      },
    ];

    const result = applySchemaActions(schema, actions);

    // Version incremented by 1 (not by the number of actions)
    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    // price was added then removed; title was made required
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('title');
    expect(result.fields[0].required).toBe(true);
  });

  // --- group_fields: non-contiguous source fields ---

  it('group_fields: non-contiguous source fields are grouped correctly', () => {
    const schema = makeSchema([
      makeField('alpha'), // position 0 — source
      makeField('beta'), // position 1 — non-source
      makeField('gamma'), // position 2 — source
      makeField('delta'), // position 3 — non-source
      makeField('epsilon'), // position 4 — source
    ]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'group_fields',
      payload: {
        targetFieldName: 'grouped',
        targetFieldType: 'object',
        sourceFields: ['alpha', 'gamma', 'epsilon'],
        mapping: { alpha: 'a', gamma: 'g', epsilon: 'e' },
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    // grouped should be at position 0 (where alpha was), then beta, delta
    expect(result.fields.map((f) => f.name)).toEqual(['grouped', 'beta', 'delta']);

    const groupedField = result.fields.find((f) => f.name === 'grouped')!;
    expect(groupedField.type).toBe('object');
    expect(groupedField.objectFields).toHaveLength(3);
    expect(groupedField.objectFields!.map((f) => f.name)).toEqual(['a', 'g', 'e']);
  });

  it('group_fields: unmapped source field keeps its original name', () => {
    const schema = makeSchema([makeField('street'), makeField('city'), makeField('zip')]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'group_fields',
      payload: {
        targetFieldName: 'address',
        targetFieldType: 'object',
        sourceFields: ['street', 'city', 'zip'],
        mapping: { street: 'streetName', city: 'cityName' }, // zip is NOT in the mapping
      },
    };

    const result = applySchemaActions(schema, [action]);

    expect(result.version).toBe(2);
    expect(result.fields).toHaveLength(1);

    const addressField = result.fields.find((f) => f.name === 'address')!;
    expect(addressField.objectFields).toHaveLength(3);
    expect(addressField.objectFields!.map((f) => f.name)).toEqual([
      'streetName',
      'cityName',
      'zip',
    ]);
  });

  // --- immutability ---

  it('does not mutate the original schema', () => {
    const schema = makeSchema([makeField('title', { required: false })]);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'modify_field',
      payload: {
        fieldName: 'title',
        changes: { required: true },
      },
    };

    const result = applySchemaActions(schema, [action]);

    // Original should be untouched
    expect(schema.fields[0].required).toBe(false);
    expect(schema.version).toBe(1);
    expect(schema.parentVersion).toBeNull();

    // Result should be modified
    expect(result.fields[0].required).toBe(true);
    expect(result.version).toBe(2);
  });
});
