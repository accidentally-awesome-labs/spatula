import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/cursor.js';

describe('cursor encoding', () => {
  it('encodes and decodes a cursor with id and sortValue', () => {
    const cursor = encodeCursor({ id: 'abc-123', sortValue: '2026-03-28' });
    expect(typeof cursor).toBe('string');
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('abc-123');
    expect(decoded.sortValue).toBe('2026-03-28');
  });

  it('encodes and decodes with numeric sortValue', () => {
    const cursor = encodeCursor({ id: 'entity-1', sortValue: 0.95 });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('entity-1');
    expect(decoded.sortValue).toBe(0.95);
  });

  it('encodes and decodes with id only', () => {
    const cursor = encodeCursor({ id: 'entity-1' });
    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe('entity-1');
    expect(decoded.sortValue).toBeUndefined();
  });

  it('throws on invalid cursor string', () => {
    expect(() => decodeCursor('not-valid')).toThrow();
  });

  it('produces URL-safe base64', () => {
    const cursor = encodeCursor({ id: 'test+value/here=now', sortValue: 'data' });
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('=');
  });
});
