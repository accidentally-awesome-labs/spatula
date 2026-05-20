import { describe, it, expect } from 'vitest';
import { buildOriginMatcher } from './cors-origin.js';

describe('buildOriginMatcher', () => {
  describe('Test 1: exact single origin', () => {
    it('matches the exact origin', () => {
      const matcher = buildOriginMatcher('https://app.example.com');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://app.example.com')).toBe(true);
    });

    it('rejects a different origin', () => {
      const matcher = buildOriginMatcher('https://app.example.com');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://other.example.com')).toBe(false);
    });
  });

  describe('Test 2: comma-separated list with whitespace', () => {
    it('matches both origins in a comma-separated list', () => {
      const matcher = buildOriginMatcher('https://a.com, https://b.com');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://a.com')).toBe(true);
      expect(matcher!.match('https://b.com')).toBe(true);
    });

    it('trims whitespace around origins', () => {
      const matcher = buildOriginMatcher('  https://a.com  ,  https://b.com  ');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://a.com')).toBe(true);
      expect(matcher!.match('https://b.com')).toBe(true);
    });

    it('rejects an unlisted origin', () => {
      const matcher = buildOriginMatcher('https://a.com, https://b.com');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://c.com')).toBe(false);
    });
  });

  describe('Test 3: single-label wildcard', () => {
    it('matches a single-label subdomain against https://*.spatula.dev', () => {
      const matcher = buildOriginMatcher('https://*.spatula.dev');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://app.spatula.dev')).toBe(true);
      expect(matcher!.match('https://docs.spatula.dev')).toBe(true);
    });
  });

  describe('Test 4: wildcard subdomain security boundaries', () => {
    it('does NOT match two-label subdomain (foo.bar.spatula.dev)', () => {
      const matcher = buildOriginMatcher('https://*.spatula.dev');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://foo.bar.spatula.dev')).toBe(false);
    });

    it('does NOT match the base domain without a subdomain (spatula.dev)', () => {
      const matcher = buildOriginMatcher('https://*.spatula.dev');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://spatula.dev')).toBe(false);
    });

    it('does NOT match suffix attack (evil.spatula.dev.attacker.com)', () => {
      const matcher = buildOriginMatcher('https://*.spatula.dev');
      expect(matcher).not.toBeNull();
      expect(matcher!.match('https://evil.spatula.dev.attacker.com')).toBe(false);
    });
  });

  describe('Test 5: empty / whitespace-only returns null', () => {
    it('returns null for empty string', () => {
      expect(buildOriginMatcher('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(buildOriginMatcher('   ')).toBeNull();
    });

    it('returns null for comma-only string with no real parts', () => {
      expect(buildOriginMatcher(' , , ')).toBeNull();
    });
  });

  describe('Test 6: bare * is rejected', () => {
    it('returns null for a bare * entry', () => {
      expect(buildOriginMatcher('*')).toBeNull();
    });

    it('returns null when * is mixed with valid origins', () => {
      expect(buildOriginMatcher('https://app.example.com,*')).toBeNull();
    });
  });
});
