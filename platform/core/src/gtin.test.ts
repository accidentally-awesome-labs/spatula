import { describe, expect, it } from 'vitest';
import { normalizeGtin } from './gtin';

describe('normalizeGtin', () => {
  it('pads valid GTINs to 14 digits', () => {
    expect(normalizeGtin('4006381333931')).toBe('04006381333931');
    expect(normalizeGtin('819343015004')).toBe('00819343015004');
    expect(normalizeGtin('96385074')).toBe('00000096385074');
    expect(normalizeGtin('00819343015004')).toBe('00819343015004');
  });

  it('ignores spaces and hyphens', () => {
    expect(normalizeGtin(' 8193 4301-5004 ')).toBe('00819343015004');
  });

  it('refuses wrong check digits, lengths, letters, and all zeros', () => {
    expect(normalizeGtin('819343015005')).toBeNull();
    expect(normalizeGtin('12345')).toBeNull();
    expect(normalizeGtin('81934301500A')).toBeNull();
    expect(normalizeGtin('0000000000000')).toBeNull();
  });
});
