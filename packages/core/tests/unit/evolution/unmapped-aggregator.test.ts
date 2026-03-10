import { describe, it, expect } from 'vitest';
import {
  aggregateUnmappedFields,
  type AggregatedField,
} from '../../../src/evolution/unmapped-aggregator.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

function makeExtraction(
  overrides: Partial<ExtractionResult> & {
    metadata: ExtractionResult['metadata'];
  },
): ExtractionResult {
  return {
    id: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    pageId: crypto.randomUUID(),
    schemaVersion: 1,
    data: {},
    ...overrides,
  };
}

function makeResult(
  unmappedFields: ExtractionResult['metadata']['unmappedFields'],
): ExtractionResult {
  return makeExtraction({
    metadata: {
      confidence: 0.9,
      modelUsed: 'test-model',
      tokensUsed: 100,
      extractionTimeMs: 50,
      unmappedFields,
    },
  });
}

describe('aggregateUnmappedFields', () => {
  it('returns an empty array when given no extractions', () => {
    const result = aggregateUnmappedFields([]);
    expect(result).toEqual([]);
  });

  it('returns an empty array when extractions have no unmapped fields', () => {
    const results = [makeResult([]), makeResult([])];
    const aggregated = aggregateUnmappedFields(results);
    expect(aggregated).toEqual([]);
  });

  it('groups fields by normalized name (case-insensitive, whitespace→underscores)', () => {
    const results = [
      makeResult([{ name: 'Phone Number', value: '555-0100', suggestedType: 'string' }]),
      makeResult([{ name: 'phone_number', value: '555-0200', suggestedType: 'string' }]),
      makeResult([{ name: 'PHONE NUMBER', value: '555-0300', suggestedType: 'string' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].normalizedName).toBe('phone_number');
    expect(aggregated[0].occurrences).toBe(3);
    expect(aggregated[0].frequency).toBeCloseTo(1.0);
    expect(aggregated[0].observedNames).toEqual(
      expect.arrayContaining(['Phone Number', 'phone_number', 'PHONE NUMBER']),
    );
    expect(aggregated[0].sampleValues).toEqual(
      expect.arrayContaining(['555-0100', '555-0200', '555-0300']),
    );
  });

  it('deduplicates fields within a single extraction', () => {
    const results = [
      makeResult([
        { name: 'color', value: 'red', suggestedType: 'string' },
        { name: 'Color', value: 'blue', suggestedType: 'string' },
      ]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    // Same extraction should count as 1 occurrence even with two variants
    expect(aggregated[0].occurrences).toBe(1);
    expect(aggregated[0].frequency).toBeCloseTo(1.0);
    // But both sample values should be collected
    expect(aggregated[0].sampleValues).toEqual(expect.arrayContaining(['red', 'blue']));
    // Both name variants should be tracked
    expect(aggregated[0].observedNames).toEqual(expect.arrayContaining(['color', 'Color']));
  });

  it('sorts results by occurrences descending', () => {
    const results = [
      makeResult([
        { name: 'rare_field', value: 'x', suggestedType: 'string' },
        { name: 'common_field', value: 'a', suggestedType: 'string' },
      ]),
      makeResult([{ name: 'common_field', value: 'b', suggestedType: 'string' }]),
      makeResult([{ name: 'common_field', value: 'c', suggestedType: 'string' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(2);
    expect(aggregated[0].normalizedName).toBe('common_field');
    expect(aggregated[0].occurrences).toBe(3);
    expect(aggregated[1].normalizedName).toBe('rare_field');
    expect(aggregated[1].occurrences).toBe(1);
  });

  it('caps sample values at 10', () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeResult([{ name: 'field', value: `value-${i}`, suggestedType: 'string' }]),
    );

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].sampleValues).toHaveLength(10);
    expect(aggregated[0].occurrences).toBe(15);
  });

  it('determines the dominant type from the most common suggestedType', () => {
    const results = [
      makeResult([{ name: 'rating', value: '4.5', suggestedType: 'string' }]),
      makeResult([{ name: 'rating', value: 4.2, suggestedType: 'number' }]),
      makeResult([{ name: 'rating', value: 3.8, suggestedType: 'number' }]),
      makeResult([{ name: 'rating', value: 4.9, suggestedType: 'number' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].dominantType).toBe('number');
    expect(aggregated[0].typeCounts).toEqual({ string: 1, number: 3 });
  });

  it('calculates frequency correctly as occurrences / total extractions', () => {
    const results = [
      makeResult([{ name: 'weight', value: '5kg', suggestedType: 'string' }]),
      makeResult([{ name: 'weight', value: '3kg', suggestedType: 'string' }]),
      makeResult([]),
      makeResult([]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].occurrences).toBe(2);
    expect(aggregated[0].frequency).toBeCloseTo(0.5);
  });

  it('normalizes names with multiple whitespace characters', () => {
    const results = [
      makeResult([{ name: 'product  name', value: 'Widget', suggestedType: 'string' }]),
      makeResult([{ name: 'product\tname', value: 'Gadget', suggestedType: 'string' }]),
      makeResult([{ name: 'product_name', value: 'Doohickey', suggestedType: 'string' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].normalizedName).toBe('product_name');
    expect(aggregated[0].occurrences).toBe(3);
  });

  it('tracks multiple distinct fields correctly', () => {
    const results = [
      makeResult([
        { name: 'brand', value: 'Acme', suggestedType: 'string' },
        { name: 'weight', value: '2kg', suggestedType: 'string' },
      ]),
      makeResult([
        { name: 'brand', value: 'Globex', suggestedType: 'string' },
        { name: 'color', value: 'red', suggestedType: 'string' },
      ]),
      makeResult([
        { name: 'brand', value: 'Initech', suggestedType: 'string' },
        { name: 'weight', value: '5kg', suggestedType: 'string' },
        { name: 'color', value: 'blue', suggestedType: 'string' },
      ]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated).toHaveLength(3);
    // Sorted by occurrences descending
    expect(aggregated[0].normalizedName).toBe('brand');
    expect(aggregated[0].occurrences).toBe(3);
    expect(aggregated[1].occurrences).toBe(2);
    expect(aggregated[2].occurrences).toBe(2);
  });

  it('does not include duplicate observed name variants', () => {
    const results = [
      makeResult([{ name: 'Color', value: 'red', suggestedType: 'string' }]),
      makeResult([{ name: 'Color', value: 'blue', suggestedType: 'string' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated[0].observedNames).toEqual(['Color']);
  });

  it('does not include duplicate sample values', () => {
    const results = [
      makeResult([{ name: 'status', value: 'active', suggestedType: 'string' }]),
      makeResult([{ name: 'status', value: 'active', suggestedType: 'string' }]),
      makeResult([{ name: 'status', value: 'inactive', suggestedType: 'string' }]),
    ];

    const aggregated = aggregateUnmappedFields(results);

    expect(aggregated[0].sampleValues).toEqual(['active', 'inactive']);
  });
});
