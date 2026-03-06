import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEnvOrThrow, getEnvOrDefault } from '../src/config.js';

describe('getEnvOrThrow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'test_value');
    expect(getEnvOrThrow('TEST_KEY')).toBe('test_value');
  });

  it('throws if not set', () => {
    expect(() => getEnvOrThrow('MISSING_KEY')).toThrow('MISSING_KEY');
  });
});

describe('getEnvOrDefault', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'real_value');
    expect(getEnvOrDefault('TEST_KEY', 'default')).toBe('real_value');
  });

  it('returns default if not set', () => {
    expect(getEnvOrDefault('MISSING_KEY', 'fallback')).toBe('fallback');
  });
});
