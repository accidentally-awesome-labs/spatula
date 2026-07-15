import type { MiddlewareHandler } from 'hono';
import { AuthInsufficientScopeError } from '@accidentally-awesome-labs/spatula-shared';
import type { AuthResult } from '@accidentally-awesome-labs/spatula-shared';

export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as AuthResult | undefined;
    if (!auth) {
      throw new AuthInsufficientScopeError(`Scope "${scope}" required`, {
        context: { requiredScope: scope },
      });
    }

    if (auth.scopes.includes('admin') || auth.scopes.includes(scope)) {
      return next();
    }

    throw new AuthInsufficientScopeError(`Insufficient permissions: requires "${scope}"`, {
      context: { requiredScope: scope, grantedScopes: auth.scopes },
    });
  };
}
