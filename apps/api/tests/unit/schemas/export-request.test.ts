import { describe, it, expect } from 'vitest';
import { exportRequestSchema } from '../../../src/schemas/export-request.js';

describe('exportRequestSchema', () => {
  it('accepts valid minQuality', () => {
    const result = exportRequestSchema.safeParse({ format: 'json', minQuality: 0.7 });
    expect(result.success).toBe(true);
  });

  it('rejects minQuality > 1', () => {
    const result = exportRequestSchema.safeParse({ format: 'json', minQuality: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects minQuality < 0', () => {
    const result = exportRequestSchema.safeParse({ format: 'json', minQuality: -0.1 });
    expect(result.success).toBe(false);
  });

  it('accepts fields array', () => {
    const result = exportRequestSchema.safeParse({ format: 'csv', fields: ['name', 'price'] });
    expect(result.success).toBe(true);
  });
});
