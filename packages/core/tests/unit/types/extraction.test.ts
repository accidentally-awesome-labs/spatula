import { describe, it, expect } from 'vitest';
import {
  ExtractionResult,
  ValueProvenance,
  PageClassification,
} from '../../../src/types/extraction.js';

describe('ExtractionResult', () => {
  it('parses a valid extraction result', () => {
    const result = ExtractionResult.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      jobId: '550e8400-e29b-41d4-a716-446655440001',
      pageId: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: 3,
      data: {
        name: 'Sennheiser HD 650',
        price: { amount: 299, currency: 'USD' },
      },
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 1450,
        extractionTimeMs: 2300,
        unmappedFields: [{ name: 'warranty', value: '2 years', suggestedType: 'string' }],
      },
    });
    expect(result.schemaVersion).toBe(3);
    expect(result.metadata.unmappedFields).toHaveLength(1);
  });

  it('rejects confidence outside 0-1 range', () => {
    expect(() =>
      ExtractionResult.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        jobId: '550e8400-e29b-41d4-a716-446655440001',
        pageId: '550e8400-e29b-41d4-a716-446655440002',
        schemaVersion: 1,
        data: {},
        metadata: {
          confidence: 1.5,
          modelUsed: 'test',
          tokensUsed: 0,
          extractionTimeMs: 0,
          unmappedFields: [],
        },
      }),
    ).toThrow();
  });
});

describe('ValueProvenance', () => {
  it('accepts all valid provenance types', () => {
    const types = ['extracted', 'normalized', 'merged', 'resolved', 'inferred'];
    for (const t of types) {
      expect(ValueProvenance.parse(t)).toBe(t);
    }
  });
});

describe('PageClassification', () => {
  it('accepts all valid classifications', () => {
    const types = ['single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial'];
    for (const t of types) {
      expect(PageClassification.parse(t)).toBe(t);
    }
  });
});
