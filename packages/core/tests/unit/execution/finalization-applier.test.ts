import { describe, it, expect } from 'vitest';
import {
  applyFinalizationAction,
  type FinalizationResult,
} from '../../../src/execution/finalization-applier.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'quality_audit',
    reasoning: 'test',
    confidence: 0.9,
  };
}

describe('applyFinalizationAction', () => {
  it('recommend_table_structure returns metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'recommend_table_structure',
      payload: {
        strategy: 'multi_table',
        tables: [
          { name: 'products', description: 'Main products', fields: ['name', 'price'], relationship: 'primary' },
          { name: 'reviews', description: 'Product reviews', fields: ['rating', 'text'], relationship: 'child', foreignKey: 'product_id' },
        ],
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.tableStructure).toBeDefined();
    expect(result.metadata!.tableStructure!.strategy).toBe('multi_table');
    expect(result.metadata!.tableStructure!.tables).toHaveLength(2);
  });

  it('derive_field returns derivation metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'derive_field',
      payload: {
        fieldName: 'price_per_unit',
        fieldDefinition: { name: 'price_per_unit', description: 'Price per unit', type: 'number', required: false },
        derivedFrom: ['price', 'quantity'],
        derivationLogic: 'price / quantity',
        examples: [{ inputs: { price: 10, quantity: 2 }, output: 5 }],
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.derivedField).toBeDefined();
    expect(result.metadata!.derivedField!.fieldName).toBe('price_per_unit');
  });

  it('flag_anomaly returns anomaly record', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'flag_anomaly',
      payload: {
        entityId: generateId(),
        fieldName: 'price',
        anomalyType: 'outlier_value',
        description: 'Price is 10x higher than median',
        suggestedFix: 99.99,
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.anomaly).toBeDefined();
    expect(result.metadata!.anomaly!.anomalyType).toBe('outlier_value');
  });

  it('generate_documentation returns documentation metadata', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'generate_documentation',
      payload: {
        dataDictionary: [
          {
            fieldName: 'name',
            description: 'Product name',
            exampleValues: ['Widget A', 'Widget B'],
            coveragePercent: 0.95,
            sources: ['site-a.com'],
          },
        ],
        categoryBreakdown: [
          { category: 'electronics', count: 50, specificFields: ['voltage'] },
        ],
        qualitySummary: {
          totalEntities: 100,
          totalSources: 5,
          averageFieldCompleteness: 0.85,
          anomaliesFound: 3,
          anomaliesResolved: 2,
        },
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.documentation).toBeDefined();
  });

  it('returns applied=false for non-finalization action', () => {
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

    const result = applyFinalizationAction(action);
    expect(result.applied).toBe(false);
  });

  it('recommend_table_structure omits relationship/foreignKey when not provided', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'recommend_table_structure',
      payload: {
        strategy: 'single_table',
        tables: [
          { name: 'products', description: 'All products', fields: ['name', 'price'] },
        ],
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.tableStructure).toBeDefined();
    expect(result.metadata!.tableStructure!.tables).toHaveLength(1);
    const table = result.metadata!.tableStructure!.tables[0];
    expect(table.name).toBe('products');
    expect(table).not.toHaveProperty('relationship');
    expect(table).not.toHaveProperty('foreignKey');
  });

  it('flag_anomaly works with only anomalyType and description', () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'flag_anomaly',
      payload: {
        anomalyType: 'missing_data',
        description: 'Several entities are missing required fields',
      },
    };

    const result = applyFinalizationAction(action);

    expect(result.applied).toBe(true);
    expect(result.metadata?.anomaly).toBeDefined();
    expect(result.metadata!.anomaly!.anomalyType).toBe('missing_data');
    expect(result.metadata!.anomaly!.description).toBe('Several entities are missing required fields');
    expect(result.metadata!.anomaly!.entityId).toBeUndefined();
    expect(result.metadata!.anomaly!.fieldName).toBeUndefined();
  });
});
