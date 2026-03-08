import { describe, it, expect } from 'vitest';
import { PipelineAction, ActionStatus, ActionSource, SafetyPolicy } from '../../../src/types/actions.js';

describe('PipelineAction', () => {
  const base = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    jobId: '550e8400-e29b-41d4-a716-446655440001',
    source: 'schema_evolution' as const,
    reasoning: 'Field observed in 92% of headphone extractions',
    confidence: 0.92,
  };

  it('parses add_field action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'add_field',
      payload: {
        field: { name: 'impedance', description: 'Impedance in ohms', type: 'string' },
        relevance: {
          globalFrequency: 0.4,
          categoryBreakdown: [{ category: 'headphone', frequency: 0.92, sampleSize: 63 }],
          classification: 'categorical_required',
          applicableCategories: ['headphone'],
        },
      },
    });
    expect(result.type).toBe('add_field');
  });

  it('parses merge_fields action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'merge_fields',
      payload: {
        canonicalName: 'price',
        aliasNames: ['retail_price', 'msrp'],
        canonicalDefinition: { name: 'price', description: 'Product price', type: 'currency' },
        valueMappings: {},
      },
    });
    expect(result.type).toBe('merge_fields');
    expect(result.payload.aliasNames).toHaveLength(2);
  });

  it('parses classify_page action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'classify_page',
      payload: {
        pageId: '550e8400-e29b-41d4-a716-446655440003',
        classification: 'single_entry',
        extractionStrategy: 'full_extraction',
      },
    });
    expect(result.payload.classification).toBe('single_entry');
  });

  it('parses match_entities action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'match_entities',
      source: 'reconciliation',
      payload: {
        entityId: '550e8400-e29b-41d4-a716-446655440004',
        extractionIds: [
          '550e8400-e29b-41d4-a716-446655440005',
          '550e8400-e29b-41d4-a716-446655440006',
        ],
        matchedOn: ['name', 'brand'],
      },
    });
    expect(result.payload.extractionIds).toHaveLength(2);
  });

  it('parses flag_anomaly action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'flag_anomaly',
      source: 'quality_audit',
      payload: {
        anomalyType: 'outlier_value',
        description: 'Price $99999 seems too high',
        entityId: '550e8400-e29b-41d4-a716-446655440007',
        fieldName: 'price',
      },
    });
    expect(result.type).toBe('flag_anomaly');
  });

  it('parses generate_documentation action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'generate_documentation',
      payload: {
        dataDictionary: [
          {
            fieldName: 'name',
            description: 'Product name',
            exampleValues: ['HD 650', 'LCD-X'],
            coveragePercent: 100,
            sources: ['head-fi.org', 'amazon.com'],
          },
        ],
        categoryBreakdown: [
          { category: 'headphone', count: 63, specificFields: ['driver_type', 'impedance'] },
        ],
        qualitySummary: {
          totalEntities: 142,
          totalSources: 3,
          averageFieldCompleteness: 0.78,
          anomaliesFound: 5,
          anomaliesResolved: 3,
        },
      },
    });
    expect(result.type).toBe('generate_documentation');
  });

  it('rejects invalid action type', () => {
    expect(() =>
      PipelineAction.parse({ ...base, type: 'nonexistent', payload: {} })
    ).toThrow();
  });
});

describe('ActionStatus', () => {
  it('accepts all valid statuses', () => {
    const statuses = ['pending_review', 'approved', 'applied', 'rejected', 'rolled_back'];
    for (const s of statuses) {
      expect(ActionStatus.parse(s)).toBe(s);
    }
  });
});

describe('ActionSource', () => {
  it('accepts all valid sources', () => {
    const sources = ['extraction', 'schema_evolution', 'reconciliation', 'quality_audit'];
    for (const s of sources) {
      expect(ActionSource.parse(s)).toBe(s);
    }
  });
});

describe('SafetyPolicy', () => {
  it('accepts all valid policies', () => {
    const policies = ['always_auto', 'auto_above_threshold', 'always_review', 'batch_review'];
    for (const p of policies) {
      expect(SafetyPolicy.parse(p)).toBe(p);
    }
  });
});
