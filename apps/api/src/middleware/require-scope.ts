import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from '@spatula/shared';
import type { AuthResult } from '@spatula/shared';

export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as AuthResult | undefined;
    if (!auth) {
      throw new ForbiddenError(`Scope "${scope}" required`);
    }

    if (auth.scopes.includes('admin') || auth.scopes.includes(scope)) {
      return next();
    }

    throw new ForbiddenError(`Insufficient permissions: requires "${scope}"`);
  };
}
