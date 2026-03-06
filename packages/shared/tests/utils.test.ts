import { describe, it, expect } from 'vitest';
import { generateId, sleep, chunk, extractDomain } from '../src/utils.js';

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('chunk', () => {
  it('splits array into chunks of given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns single chunk if array is smaller than size', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('returns empty array for empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('extractDomain', () => {
  it('extracts domain from full URL', () => {
    expect(extractDomain('https://www.head-fi.org/threads/123')).toBe('head-fi.org');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  it('handles URLs without www', () => {
    expect(extractDomain('https://api.example.com/v1')).toBe('api.example.com');
  });
});
