import { describe, it, expect, vi } from 'vitest';
import { createAuthProvider } from '../../../src/auth/factory.js';
import { NoAuthProvider } from '../../../src/auth/no-auth-provider.js';
import { ApiKeyAuthProvider } from '../../../src/auth/api-key-provider.js';

describe('createAuthProvider', () => {
  const mockApiKeyRepo = { findByHash: vi.fn() } as any;

  it('returns NoAuthProvider for strategy "none"', () => {
    const provider = createAuthProvider('none', { apiKeyRepo: mockApiKeyRepo });
    expect(provider).toBeInstanceOf(NoAuthProvider);
  });

  it('returns ApiKeyAuthProvider for strategy "api-key"', () => {
    const provider = createAuthProvider('api-key', { apiKeyRepo: mockApiKeyRepo });
    expect(provider).toBeInstanceOf(ApiKeyAuthProvider);
  });

  it('throws for unsupported strategy', () => {
    expect(() => createAuthProvider('jwt', { apiKeyRepo: mockApiKeyRepo })).toThrow(
      'Auth strategy "jwt" is not yet supported',
    );
  });

  it('throws for unknown strategy', () => {
    expect(() => createAuthProvider('invalid' as any, { apiKeyRepo: mockApiKeyRepo })).toThrow(
      'Unknown auth strategy: invalid',
    );
  });
});
