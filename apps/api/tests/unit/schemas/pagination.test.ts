import { describe, it, expect } from 'vitest';
import { paginationSchema } from '../../../src/schemas/pagination.js';

describe('paginationSchema', () => {
  it('provides defaults', () => {
    const result = paginationSchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('accepts valid values', () => {
    const result = paginationSchema.parse({ limit: '10', offset: '20' });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(20);
  });

  it('caps limit at 100', () => {
    const result = paginationSchema.parse({ limit: '200' });
    expect(result.limit).toBe(100);
  });

  it('rejects negative offset', () => {
    expect(() => paginationSchema.parse({ offset: '-1' })).toThrow();
  });
});
