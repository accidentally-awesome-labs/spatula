import { describe, it, expect } from 'vitest';
import { EntityMatch, SourceTrust, TrustLevel } from '../../../src/types/reconciliation.js';

describe('EntityMatch', () => {
  it('parses a complete entity match', () => {
    const result = EntityMatch.parse({
      entityId: '550e8400-e29b-41d4-a716-446655440000',
      sourceExtractions: [
        {
          extractionId: '550e8400-e29b-41d4-a716-446655440001',
          sourceUrl: 'https://amazon.com/hd650',
          sourceDomain: 'amazon.com',
          crawledAt: new Date().toISOString(),
          fieldsCovered: ['name', 'price'],
        },
        {
          extractionId: '550e8400-e29b-41d4-a716-446655440002',
          sourceUrl: 'https://head-fi.org/hd650',
          sourceDomain: 'head-fi.org',
          crawledAt: new Date().toISOString(),
          fieldsCovered: ['name', 'driver_type', 'impedance'],
        },
      ],
      mergedData: {
        name: 'Sennheiser HD 650',
        price: { amount: 299, currency: 'USD' },
        driver_type: 'dynamic',
        impedance: '300',
      },
      fieldProvenance: {
        name: {
          finalValue: 'Sennheiser HD 650',
          provenanceType: 'extracted',
          sources: [
            { sourceUrl: 'https://amazon.com/hd650', rawValue: 'Sennheiser HD 650', normalizedValue: 'Sennheiser HD 650' },
          ],
          hadConflict: false,
        },
        price: {
          finalValue: { amount: 299, currency: 'USD' },
          provenanceType: 'normalized',
          sources: [
            { sourceUrl: 'https://amazon.com/hd650', rawValue: '$299.00', normalizedValue: { amount: 299, currency: 'USD' } },
          ],
          hadConflict: false,
        },
      },
    });
    expect(result.sourceExtractions).toHaveLength(2);
    expect(result.fieldProvenance['name'].hadConflict).toBe(false);
  });
});

describe('SourceTrust', () => {
  it('parses source trust config', () => {
    const result = SourceTrust.parse({
      domain: 'sennheiser.com',
      trustLevel: 'authoritative',
      reasoning: 'Official manufacturer website',
    });
    expect(result.trustLevel).toBe('authoritative');
  });
});

describe('TrustLevel', () => {
  it('accepts all valid levels', () => {
    for (const level of ['authoritative', 'high', 'medium', 'low']) {
      expect(TrustLevel.parse(level)).toBe(level);
    }
  });
});
