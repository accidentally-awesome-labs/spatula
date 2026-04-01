import { describe, it, expect } from 'vitest';
import { validateAndDedup } from '../../../src/commands/add.js';

describe('validateAndDedup', () => {
  it('rejects invalid URLs', () => {
    const result = validateAndDedup(['not-a-url'], []);
    expect(result.invalid).toContain('not-a-url');
    expect(result.valid).toHaveLength(0);
  });

  it('deduplicates against existing seeds', () => {
    const result = validateAndDedup(['https://example.com', 'https://new.com'], ['https://example.com']);
    expect(result.valid).toEqual(['https://new.com']);
    expect(result.duplicates).toContain('https://example.com');
  });

  it('normalises trailing slashes for dedup', () => {
    const result = validateAndDedup(['https://example.com/'], ['https://example.com']);
    expect(result.duplicates).toContain('https://example.com/');
    expect(result.valid).toHaveLength(0);
  });

  it('deduplicates within provided URLs', () => {
    const result = validateAndDedup(['https://example.com', 'https://example.com'], []);
    expect(result.valid).toEqual(['https://example.com']);
  });

  it('returns all valid when no duplicates', () => {
    const result = validateAndDedup(['https://a.com', 'https://b.com'], []);
    expect(result.valid).toEqual(['https://a.com', 'https://b.com']);
    expect(result.invalid).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });
});
