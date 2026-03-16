import { describe, it, expect } from 'vitest';
import { entityQuerySchema } from '../../../src/schemas/entity-query.js';

describe('entityQuerySchema', () => {
  it('accepts limit and offset (inherits from paginationSchema)', () => {
    const result = entityQuerySchema.safeParse({ limit: '10', offset: '5' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ limit: 10, offset: 5 }));
  });

  it('accepts search parameter', () => {
    const result = entityQuerySchema.safeParse({ search: 'bluetooth' });
    expect(result.success).toBe(true);
    expect(result.data!.search).toBe('bluetooth');
  });

  it('makes search optional', () => {
    const result = entityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.search).toBeUndefined();
  });

  it('applies default pagination when no params', () => {
    const result = entityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(50);
    expect(result.data!.offset).toBe(0);
  });

  it('caps limit at 100', () => {
    const result = entityQuerySchema.safeParse({ limit: '999' });
    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(100);
  });
});
