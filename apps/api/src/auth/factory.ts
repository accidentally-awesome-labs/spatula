import type { AuthProvider } from '@spatula/shared';
import { ConfigError } from '@spatula/shared';
import type { ApiKeyRepository } from '@spatula/db';
import { NoAuthProvider } from './no-auth-provider.js';
import { ApiKeyAuthProvider } from './api-key-provider.js';

export type AuthStrategy = 'none' | 'api-key' | 'jwt';

export interface AuthProviderDeps {
  apiKeyRepo: ApiKeyRepository;
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
      throw new ConfigError('Auth strategy "jwt" is not yet supported');
    default:
      throw new ConfigError(`Unknown auth strategy: ${strategy}`);
  }
}
