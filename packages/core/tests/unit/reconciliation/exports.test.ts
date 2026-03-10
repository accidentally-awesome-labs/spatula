import { describe, it, expect } from 'vitest';
import * as reconciliation from '../../../src/reconciliation/index.js';

describe('reconciliation exports', () => {
  it('exports applyNormalizationRule', () => {
    expect(reconciliation.applyNormalizationRule).toBeTypeOf('function');
  });

  it('exports normalizeExtractionData', () => {
    expect(reconciliation.normalizeExtractionData).toBeTypeOf('function');
  });

  it('exports matchEntitiesExact', () => {
    expect(reconciliation.matchEntitiesExact).toBeTypeOf('function');
  });

  it('exports matchEntitiesCompositeKey', () => {
    expect(reconciliation.matchEntitiesCompositeKey).toBeTypeOf('function');
  });

  it('exports matchEntitiesFuzzy', () => {
    expect(reconciliation.matchEntitiesFuzzy).toBeTypeOf('function');
  });

  it('exports matchEntitiesLLM', () => {
    expect(reconciliation.matchEntitiesLLM).toBeTypeOf('function');
  });

  it('exports levenshteinSimilarity', () => {
    expect(reconciliation.levenshteinSimilarity).toBeTypeOf('function');
  });

  it('exports SourceTrustEvaluator', () => {
    expect(reconciliation.SourceTrustEvaluator).toBeTypeOf('function');
  });

  it('exports resolveConflict', () => {
    expect(reconciliation.resolveConflict).toBeTypeOf('function');
  });

  it('exports GapFiller', () => {
    expect(reconciliation.GapFiller).toBeTypeOf('function');
  });

  it('exports DataReconcilerImpl', () => {
    expect(reconciliation.DataReconcilerImpl).toBeTypeOf('function');
  });
});
