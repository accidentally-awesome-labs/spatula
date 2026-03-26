import { describe, it, expect, vi } from 'vitest';
import { createAuthProvider } from '../../../src/auth/factory.js';
import { NoAuthProvider } from '../../../src/auth/no-auth-provider.js';
import { ApiKeyAuthProvider } from '../../../src/auth/api-key-provider.js';
import { JwtAuthProvider } from '../../../src/auth/jwt-provider.js';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue(vi.fn()),
  jwtVerify: vi.fn(),
}));

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

  it('returns JwtAuthProvider for strategy "jwt" when jwtConfig is provided', () => {
    const provider = createAuthProvider('jwt', {
      apiKeyRepo: mockApiKeyRepo,
      jwtConfig: {
        issuer: 'https://auth.spatula.dev',
        audience: 'https://api.spatula.dev',
        jwksUrl: 'https://auth.spatula.dev/.well-known/jwks.json',
      },
    });
    expect(provider).toBeInstanceOf(JwtAuthProvider);
  });

  it('throws for strategy "jwt" when jwtConfig is missing', () => {
    expect(() => createAuthProvider('jwt', { apiKeyRepo: mockApiKeyRepo })).toThrow(
      'JWT_ISSUER, JWT_AUDIENCE, and JWT_JWKS_URL are required for jwt strategy',
    );
  });

  it('throws for unknown strategy', () => {
    expect(() => createAuthProvider('invalid' as any, { apiKeyRepo: mockApiKeyRepo })).toThrow(
      'Unknown auth strategy: invalid',
    );
  });
});
