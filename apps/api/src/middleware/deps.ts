import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from '../types.js';

export function depsMiddleware(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    c.set('deps', deps);
    return next();
  };
}
