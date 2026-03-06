import { describe, it, expect } from 'vitest';
import { NormalizationRule } from '../../../src/types/normalization.js';

describe('NormalizationRule', () => {
  it('parses a currency normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'currency',
      config: { targetCurrency: 'USD', decimalPlaces: 2 },
    });
    expect(result.type).toBe('currency');
    expect(result.config.targetCurrency).toBe('USD');
  });

  it('parses an enum normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'enum',
      config: {
        canonicalValues: ['over-ear', 'on-ear', 'in-ear'],
        synonymMap: { circumaural: 'over-ear', 'Over Ear': 'over-ear' },
      },
    });
    expect(result.type).toBe('enum');
    expect(result.config.synonymMap['circumaural']).toBe('over-ear');
  });

  it('parses a text normalization rule with defaults', () => {
    const result = NormalizationRule.parse({
      type: 'text',
      config: {},
    });
    expect(result.config.casing).toBe('title');
    expect(result.config.trim).toBe(true);
  });

  it('parses a boolean normalization rule with defaults', () => {
    const result = NormalizationRule.parse({
      type: 'boolean',
      config: {},
    });
    expect(result.config.trueValues).toContain('yes');
    expect(result.config.falseValues).toContain('no');
  });

  it('parses a measurement normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'measurement',
      config: { targetUnit: 'g' },
    });
    expect(result.config.targetUnit).toBe('g');
  });

  it('parses a list normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'list',
      config: { separator: ',' },
    });
    expect(result.type).toBe('list');
  });

  it('parses an llm normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'llm',
      config: { instruction: 'Normalize to ISO 8601' },
    });
    expect(result.config.instruction).toBe('Normalize to ISO 8601');
  });

  it('rejects invalid type', () => {
    expect(() =>
      NormalizationRule.parse({ type: 'invalid', config: {} })
    ).toThrow();
  });
});
