import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { ValidationError } from '@spatula/shared';

export function validateBody<T extends z.ZodType>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);

    if (!result.success) {
      throw new ValidationError(
        `Invalid request body: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }

    c.set('validatedBody', result.data);
    return next();
  };
}

export function validateQuery<T extends z.ZodType>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const query = c.req.query();
    const result = schema.safeParse(query);

    if (!result.success) {
      throw new ValidationError(
        `Invalid query parameters: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }

    c.set('validatedQuery', result.data);
    return next();
  };
}
