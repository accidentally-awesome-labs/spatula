import { describe, it, expect } from 'vitest';
import {
  aggregateUnmappedFields,
  applySchemaActions,
  FieldProposer,
  SynonymDetector,
  NormalizationProposer,
  collectValueSamples,
  SchemaEvolverImpl,
} from '../../../src/evolution/index.js';

describe('evolution module exports', () => {
  it('exports aggregateUnmappedFields', () => {
    expect(typeof aggregateUnmappedFields).toBe('function');
  });

  it('exports applySchemaActions', () => {
    expect(typeof applySchemaActions).toBe('function');
  });

  it('exports FieldProposer', () => {
    expect(FieldProposer).toBeDefined();
  });

  it('exports SynonymDetector', () => {
    expect(SynonymDetector).toBeDefined();
  });

  it('exports NormalizationProposer', () => {
    expect(NormalizationProposer).toBeDefined();
  });

  it('exports collectValueSamples', () => {
    expect(typeof collectValueSamples).toBe('function');
  });

  it('exports SchemaEvolverImpl', () => {
    expect(SchemaEvolverImpl).toBeDefined();
  });
});
