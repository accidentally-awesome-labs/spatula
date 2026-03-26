import type { AuthProvider } from '@spatula/shared';
import { ConfigError } from '@spatula/shared';
import type { ApiKeyRepository } from '@spatula/db';
import { NoAuthProvider } from './no-auth-provider.js';
import { ApiKeyAuthProvider } from './api-key-provider.js';
import { JwtAuthProvider } from './jwt-provider.js';
import type { JwtProviderConfig } from './jwt-provider.js';

export type AuthStrategy = 'none' | 'api-key' | 'jwt';

export interface AuthProviderDeps {
  apiKeyRepo: ApiKeyRepository;
  jwtConfig?: JwtProviderConfig;
}

export function createAuthProvider(
  strategy: string,
  deps: AuthProviderDeps,
): AuthProvider {
  switch (strategy) {
    case 'none':
      return new NoAuthProvider();
    case 'api-key':
      return new ApiKeyAuthProvider(deps.apiKeyRepo);
    case 'jwt':
      if (!deps.jwtConfig) {
        throw new ConfigError('JWT_ISSUER, JWT_AUDIENCE, and JWT_JWKS_URL are required for jwt strategy');
      }
      return new JwtAuthProvider(deps.jwtConfig);
    default:
      throw new ConfigError(`Unknown auth strategy: ${strategy}`);
  }
}
