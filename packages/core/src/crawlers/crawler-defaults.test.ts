import { describe, it, expect } from 'vitest';
import { buildUserAgent, DEFAULT_USER_AGENT } from './crawler-defaults.js';

describe('buildUserAgent', () => {
  it('returns the correct User-Agent string for a given version', () => {
    expect(buildUserAgent('1.2.3')).toBe('Spatula/1.2.3 (+https://spatula.dev/abuse)');
  });

  it('includes the abuse contact URL', () => {
    const ua = buildUserAgent('2.0.0');
    expect(ua).toContain('+https://spatula.dev/abuse');
  });

  it('includes the Spatula prefix', () => {
    const ua = buildUserAgent('0.5.1');
    expect(ua).toContain('Spatula/');
  });

  it('includes the version verbatim', () => {
    const ua = buildUserAgent('3.14.159');
    expect(ua).toContain('3.14.159');
  });
});

describe('DEFAULT_USER_AGENT', () => {
  it('matches the Spatula/<semver> (+https://spatula.dev/abuse) shape', () => {
    // Must match: Spatula/<semver> (+https://spatula.dev/abuse)
    expect(DEFAULT_USER_AGENT).toMatch(
      /^Spatula\/\d+\.\d+\.\d+.*\(\+https:\/\/spatula\.dev\/abuse\)$/,
    );
  });

  it('contains the abuse contact URL', () => {
    expect(DEFAULT_USER_AGENT).toContain('+https://spatula.dev/abuse');
  });

  it('starts with the Spatula/ prefix', () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^Spatula\//);
  });
});
