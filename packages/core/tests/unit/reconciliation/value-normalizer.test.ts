import { describe, it, expect } from 'vitest';
import {
  applyNormalizationRule,
  normalizeExtractionData,
} from '../../../src/reconciliation/value-normalizer.js';
import type { NormalizationRule } from '../../../src/types/normalization.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

// ---------------------------------------------------------------------------
// applyNormalizationRule — text
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — text', () => {
  const textRule: NormalizationRule = {
    type: 'text',
    config: { casing: 'title', trim: true, collapseWhitespace: true },
  };

  it('trims, collapses whitespace, and title-cases a string', () => {
    expect(applyNormalizationRule('  hello   world  ', textRule)).toBe('Hello World');
  });

  it('applies lower casing', () => {
    const rule: NormalizationRule = {
      type: 'text',
      config: { casing: 'lower', trim: true, collapseWhitespace: true },
    };
    expect(applyNormalizationRule('  HELLO World  ', rule)).toBe('hello world');
  });

  it('applies upper casing', () => {
    const rule: NormalizationRule = {
      type: 'text',
      config: { casing: 'upper', trim: true, collapseWhitespace: true },
    };
    expect(applyNormalizationRule('hello world', rule)).toBe('HELLO WORLD');
  });

  it('preserves casing when set to preserve', () => {
    const rule: NormalizationRule = {
      type: 'text',
      config: { casing: 'preserve', trim: true, collapseWhitespace: false },
    };
    expect(applyNormalizationRule('  HeLLo   World  ', rule)).toBe('HeLLo   World');
  });

  it('returns non-string values unchanged', () => {
    expect(applyNormalizationRule(42, textRule)).toBe(42);
    expect(applyNormalizationRule(null, textRule)).toBe(null);
    expect(applyNormalizationRule(undefined, textRule)).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — enum
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — enum', () => {
  const enumRule: NormalizationRule = {
    type: 'enum',
    config: {
      canonicalValues: ['Black', 'White', 'Silver'],
      synonymMap: { black: 'Black', blk: 'Black', white: 'White', wht: 'White' },
    },
  };

  it('maps a synonym to its canonical value', () => {
    expect(applyNormalizationRule('blk', enumRule)).toBe('Black');
  });

  it('maps a case-matching synonym', () => {
    expect(applyNormalizationRule('black', enumRule)).toBe('Black');
  });

  it('returns unknown string values unchanged', () => {
    expect(applyNormalizationRule('Red', enumRule)).toBe('Red');
  });

  it('returns non-string values unchanged', () => {
    expect(applyNormalizationRule(123, enumRule)).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — currency
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — currency', () => {
  const currencyRule: NormalizationRule = {
    type: 'currency',
    config: { decimalPlaces: 2 },
  };

  it('strips $ symbol and parses to number', () => {
    expect(applyNormalizationRule('$379.99', currencyRule)).toBe(379.99);
  });

  it('strips currency code suffix', () => {
    expect(applyNormalizationRule('329.00 USD', currencyRule)).toBe(329.00);
  });

  it('strips EUR prefix', () => {
    expect(applyNormalizationRule('EUR 19.999', currencyRule)).toBe(20.00);
  });

  it('rounds already-numeric values to specified decimal places', () => {
    expect(applyNormalizationRule(19.999, currencyRule)).toBe(20.00);
  });

  it('handles string numbers without symbols', () => {
    expect(applyNormalizationRule('549', currencyRule)).toBe(549.00);
  });

  it('returns non-parseable values unchanged', () => {
    expect(applyNormalizationRule('free', currencyRule)).toBe('free');
  });

  it('returns null/undefined unchanged', () => {
    expect(applyNormalizationRule(null, currencyRule)).toBe(null);
    expect(applyNormalizationRule(undefined, currencyRule)).toBe(undefined);
  });

  it('handles comma-formatted numbers', () => {
    expect(applyNormalizationRule('$1,299.99', currencyRule)).toBe(1299.99);
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — boolean
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — boolean', () => {
  const boolRule: NormalizationRule = {
    type: 'boolean',
    config: {
      trueValues: ['yes', 'true', '1', 'available'],
      falseValues: ['no', 'false', '0', 'unavailable'],
    },
  };

  it('maps "yes" to true (case-insensitive)', () => {
    expect(applyNormalizationRule('YES', boolRule)).toBe(true);
  });

  it('maps "false" to false', () => {
    expect(applyNormalizationRule('false', boolRule)).toBe(false);
  });

  it('maps "Available" to true (case-insensitive)', () => {
    expect(applyNormalizationRule('Available', boolRule)).toBe(true);
  });

  it('returns non-matching strings unchanged', () => {
    expect(applyNormalizationRule('maybe', boolRule)).toBe('maybe');
  });

  it('returns non-string values unchanged', () => {
    expect(applyNormalizationRule(42, boolRule)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — list
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — list', () => {
  const listRule: NormalizationRule = {
    type: 'list',
    config: { separator: ',' },
  };

  it('splits a comma-separated string and trims items', () => {
    expect(applyNormalizationRule('red, green , blue', listRule)).toEqual([
      'red',
      'green',
      'blue',
    ]);
  });

  it('returns already-array values unchanged', () => {
    const arr = ['a', 'b'];
    expect(applyNormalizationRule(arr, listRule)).toEqual(['a', 'b']);
  });

  it('returns non-string, non-array values unchanged', () => {
    expect(applyNormalizationRule(42, listRule)).toBe(42);
  });

  it('uses default separator (comma) when none specified', () => {
    const ruleNoSep: NormalizationRule = { type: 'list', config: {} };
    expect(applyNormalizationRule('a, b, c', ruleNoSep)).toEqual(['a', 'b', 'c']);
  });

  it('handles pipe separator', () => {
    const pipeRule: NormalizationRule = { type: 'list', config: { separator: '|' } };
    expect(applyNormalizationRule('x | y | z', pipeRule)).toEqual(['x', 'y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — measurement
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — measurement', () => {
  it('extracts numeric + unit from compact string', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'kg' } };
    expect(applyNormalizationRule('250g', rule)).toEqual({ value: 0.25, unit: 'kg' });
  });

  it('extracts numeric + unit from spaced string', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'kg' } };
    expect(applyNormalizationRule('1.5 kg', rule)).toEqual({ value: 1.5, unit: 'kg' });
  });

  it('converts mm to m', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'm' } };
    expect(applyNormalizationRule('1500mm', rule)).toEqual({ value: 1.5, unit: 'm' });
  });

  it('converts cm to m', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'm' } };
    expect(applyNormalizationRule('150 cm', rule)).toEqual({ value: 1.5, unit: 'm' });
  });

  it('converts oz to lb', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'lb' } };
    expect(applyNormalizationRule('32 oz', rule)).toEqual({ value: 2, unit: 'lb' });
  });

  it('converts lb to oz', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'oz' } };
    expect(applyNormalizationRule('2lb', rule)).toEqual({ value: 32, unit: 'oz' });
  });

  it('returns value and unit when no conversion needed', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'g' } };
    expect(applyNormalizationRule('500g', rule)).toEqual({ value: 500, unit: 'g' });
  });

  it('returns parsed value when no targetUnit specified', () => {
    const rule: NormalizationRule = { type: 'measurement', config: {} };
    expect(applyNormalizationRule('500g', rule)).toEqual({ value: 500, unit: 'g' });
  });

  it('returns non-string values unchanged', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'kg' } };
    expect(applyNormalizationRule(42, rule)).toBe(42);
  });

  it('returns unparseable strings unchanged', () => {
    const rule: NormalizationRule = { type: 'measurement', config: { targetUnit: 'kg' } };
    expect(applyNormalizationRule('unknown', rule)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// applyNormalizationRule — llm
// ---------------------------------------------------------------------------
describe('applyNormalizationRule — llm', () => {
  it('returns value unchanged (async LLM handled elsewhere)', () => {
    const rule: NormalizationRule = { type: 'llm', config: { instruction: 'normalize this' } };
    expect(applyNormalizationRule('some value', rule)).toBe('some value');
  });
});

// ---------------------------------------------------------------------------
// normalizeExtractionData
// ---------------------------------------------------------------------------
describe('normalizeExtractionData', () => {
  const schema: SchemaDefinition = {
    version: 1,
    fields: [
      {
        name: 'product_name',
        description: 'Name of the product',
        type: 'string',
        required: true,
        normalization: {
          type: 'text',
          config: { casing: 'title', trim: true, collapseWhitespace: true },
        },
      },
      {
        name: 'price',
        description: 'Product price',
        type: 'currency',
        required: true,
        normalization: { type: 'currency', config: { decimalPlaces: 2 } },
      },
      {
        name: 'color',
        description: 'Color option',
        type: 'enum',
        required: false,
        normalization: {
          type: 'enum',
          config: {
            canonicalValues: ['Black', 'White'],
            synonymMap: { black: 'Black', blk: 'Black' },
          },
        },
      },
      {
        name: 'description',
        description: 'Product description',
        type: 'string',
        required: false,
        // No normalization rule
      },
    ],
    fieldAliases: [],
    createdAt: new Date('2026-01-01'),
    parentVersion: null,
  };

  it('normalizes fields with rules and leaves others untouched', () => {
    const data = {
      product_name: '  sony  xm5  ',
      price: '$379.99',
      color: 'blk',
      description: 'Great headphones',
    };

    const result = normalizeExtractionData(data, schema);

    expect(result.normalizedData.product_name).toBe('Sony Xm5');
    expect(result.normalizedData.price).toBe(379.99);
    expect(result.normalizedData.color).toBe('Black');
    expect(result.normalizedData.description).toBe('Great headphones');
  });

  it('only tracks fields that actually changed', () => {
    const data = {
      product_name: '  sony  xm5  ',
      price: 379.99, // already a number rounded to 2 dp — no change after rounding
      color: 'Red', // not in synonymMap — unchanged
      description: 'Great headphones',
    };

    const result = normalizeExtractionData(data, schema);

    // product_name changed, price unchanged (379.99 rounded is still 379.99), color unchanged, description no rule
    const changedFields = result.changes.map((c) => c.fieldName);
    expect(changedFields).toContain('product_name');
    expect(changedFields).not.toContain('price');
    expect(changedFields).not.toContain('color');
    expect(changedFields).not.toContain('description');
  });

  it('handles missing fields gracefully', () => {
    const data = { product_name: 'Test' };

    const result = normalizeExtractionData(data, schema);

    // Only product_name exists in data — price, color, description are missing
    expect(result.normalizedData.product_name).toBe('Test');
    expect(result.normalizedData).not.toHaveProperty('price');
    expect(result.normalizedData).not.toHaveProperty('color');
  });

  it('records before/after in changes', () => {
    const data = { price: '$100.456' };

    const result = normalizeExtractionData(data, schema);

    const priceChange = result.changes.find((c) => c.fieldName === 'price');
    expect(priceChange).toBeDefined();
    expect(priceChange!.before).toBe('$100.456');
    expect(priceChange!.after).toBe(100.46);
  });

  it('returns empty changes for already-normalized data', () => {
    const data = {
      product_name: 'Already Title',
      price: 100.00,
      color: 'Red', // not in map — untouched
    };

    const result = normalizeExtractionData(data, schema);

    // product_name "Already Title" — trim/collapse do nothing, title case preserves
    // price 100.00 — rounding to 2dp does nothing
    // color "Red" — not in synonymMap, unchanged
    const changedFields = result.changes.map((c) => c.fieldName);
    expect(changedFields).not.toContain('price');
    expect(changedFields).not.toContain('color');
  });

  it('handles empty data object', () => {
    const result = normalizeExtractionData({}, schema);
    expect(result.normalizedData).toEqual({});
    expect(result.changes).toEqual([]);
  });

  it('preserves fields not present in schema', () => {
    const data = { product_name: 'Test', unknown_field: 'value' };

    const result = normalizeExtractionData(data, schema);

    // unknown_field is not in schema — should pass through unchanged
    expect(result.normalizedData.unknown_field).toBe('value');
  });
});
