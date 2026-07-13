/**
 * Tests for auth/types.ts — AUTH_SCOPES + DEFAULT_API_KEY_SCOPES
 *
 * Verifies:
 * - AUTH_SCOPES contains admin:forensic:read
 * - DEFAULT_API_KEY_SCOPES does NOT contain admin:forensic:read
 */
import { describe, it, expect } from 'vitest';
import { AUTH_SCOPES, DEFAULT_API_KEY_SCOPES } from './types.js';

describe('AUTH_SCOPES', () => {
  it('includes admin:forensic:read', () => {
    expect(AUTH_SCOPES).toContain('admin:forensic:read');
  });

  it('includes all pre-existing standard scopes', () => {
    const expectedScopes = [
      'jobs:read',
      'jobs:write',
      'exports:read',
      'exports:write',
      'actions:read',
      'actions:write',
      'tenants:admin',
      'keys:manage',
      'admin',
    ];
    for (const scope of expectedScopes) {
      expect(AUTH_SCOPES).toContain(scope);
    }
  });
});

describe('DEFAULT_API_KEY_SCOPES', () => {
  it('does NOT include admin:forensic:read (admin-only, least-privilege)', () => {
    expect(DEFAULT_API_KEY_SCOPES).not.toContain('admin:forensic:read');
  });

  it('includes the six standard user-facing scopes', () => {
    const expected = [
      'jobs:read',
      'jobs:write',
      'exports:read',
      'exports:write',
      'actions:read',
      'actions:write',
    ];
    for (const scope of expected) {
      expect(DEFAULT_API_KEY_SCOPES).toContain(scope);
    }
  });
});
