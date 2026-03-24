import { describe, it, expect } from 'vitest';
import { normalizeUrl, diffSeeds } from '../../../src/config/url-normalizer.js';

describe('normalizeUrl', () => {
  it('removes trailing slashes', () => {
    expect(normalizeUrl('https://example.com/products/')).toBe('https://example.com/products');
  });

  it('preserves root path without double-slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    // Root path keeps its slash — only trailing slashes on paths are removed
  });

  it('lowercases hostname', () => {
    expect(normalizeUrl('https://Example.COM/Products')).toBe('https://example.com/Products');
    // Path case is preserved (case-sensitive)
  });

  it('sorts query parameters', () => {
    expect(normalizeUrl('https://example.com/search?z=1&a=2&m=3')).toBe(
      'https://example.com/search?a=2&m=3&z=1',
    );
  });

  it('removes default ports', () => {
    expect(normalizeUrl('https://example.com:443/page')).toBe('https://example.com/page');
    expect(normalizeUrl('http://example.com:80/page')).toBe('http://example.com/page');
  });

  it('preserves non-default ports', () => {
    expect(normalizeUrl('https://example.com:8080/page')).toBe('https://example.com:8080/page');
  });

  it('removes fragments', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('handles URLs with no path', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('handles URLs with query and fragment', () => {
    expect(normalizeUrl('https://example.com/search?q=test#results')).toBe(
      'https://example.com/search?q=test',
    );
  });

  it('normalizes identical URLs to same string', () => {
    const a = normalizeUrl('https://Example.COM/products/');
    const b = normalizeUrl('https://example.com/products');
    expect(a).toBe(b);
  });
});

describe('diffSeeds', () => {
  it('detects added seeds', () => {
    const result = diffSeeds(
      ['https://example.com', 'https://new.com'],
      ['https://example.com'],
    );
    expect(result.added).toEqual(['https://new.com']);
    expect(result.removed).toEqual([]);
  });

  it('detects removed seeds', () => {
    const result = diffSeeds(
      ['https://example.com'],
      ['https://example.com', 'https://old.com'],
    );
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['https://old.com']);
  });

  it('ignores normalization differences', () => {
    const result = diffSeeds(
      ['https://example.com/products'],
      ['https://Example.COM/products/'],
    );
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('handles empty arrays', () => {
    expect(diffSeeds([], [])).toEqual({ added: [], removed: [] });
    expect(diffSeeds(['https://a.com'], [])).toEqual({
      added: ['https://a.com'],
      removed: [],
    });
  });
});
