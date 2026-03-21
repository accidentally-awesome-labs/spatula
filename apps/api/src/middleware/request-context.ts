import type { MiddlewareHandler } from 'hono';
import { createLoggerWithContext } from '@spatula/shared';
import type { AppEnv } from '../types.js';

export const requestContextMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  const logger = createLoggerWithContext('api', { requestId });

  c.set('requestId', requestId);
  c.set('logger', logger);
  c.header('x-request-id', requestId);

  await next();
};
