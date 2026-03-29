import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/cursor.js';

describe('cursor encoding', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('encodes and decodes a cursor with id and sortValue', () => {
    const cursor = encodeCursor({ id: VALID_UUID, sortValue: '2026-03-28' });
    expect(typeof cursor).toBe('string');
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(VALID_UUID);
    expect(decoded.sortValue).toBe('2026-03-28');
  });

  it('encodes and decodes with numeric sortValue', () => {
    const cursor = encodeCursor({ id: VALID_UUID, sortValue: 0.95 });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(VALID_UUID);
    expect(decoded.sortValue).toBe(0.95);
  });

  it('encodes and decodes with id only', () => {
    const cursor = encodeCursor({ id: VALID_UUID });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(VALID_UUID);
    expect(decoded.sortValue).toBeUndefined();
  });

  it('throws on invalid cursor string', () => {
    expect(() => decodeCursor('not-valid')).toThrow();
  });

  it('throws when cursor id is not a UUID', () => {
    const cursor = encodeCursor({ id: 'not-a-uuid' });
    expect(() => decodeCursor(cursor)).toThrow('Invalid cursor format');
  });

  it('accepts uppercase UUID in cursor', () => {
    const upper = '550E8400-E29B-41D4-A716-446655440000';
    const cursor = encodeCursor({ id: upper });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(upper);
  });

  it('produces URL-safe base64', () => {
    const cursor = encodeCursor({ id: VALID_UUID, sortValue: 'data' });
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('=');
  });
});
