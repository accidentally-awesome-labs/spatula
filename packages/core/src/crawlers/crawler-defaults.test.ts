import { describe, it, expect } from 'vitest';
import { buildUserAgent, DEFAULT_USER_AGENT } from './crawler-defaults.js';

describe('buildUserAgent', () => {
  it('returns the correct User-Agent string for a given version', () => {
    expect(buildUserAgent('1.2.3')).toBe(
      'Spatula/1.2.3 (+https://github.com/accidentally-awesome-labs/spatula)',
    );
  });

  it('includes the public project URL', () => {
    const ua = buildUserAgent('2.0.0');
    expect(ua).toContain('+https://github.com/accidentally-awesome-labs/spatula');
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
  it('matches the Spatula/<semver> plus public project URL shape', () => {
    // Must match: Spatula/<semver> (+https://github.com/accidentally-awesome-labs/spatula)
    expect(DEFAULT_USER_AGENT).toMatch(
      /^Spatula\/\d+\.\d+\.\d+.*\(\+https:\/\/github\.com\/accidentally-awesome-labs\/spatula\)$/,
    );
  });

  it('contains the public project URL', () => {
    expect(DEFAULT_USER_AGENT).toContain('+https://github.com/accidentally-awesome-labs/spatula');
  });

  it('starts with the Spatula/ prefix', () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^Spatula\//);
  });
});
