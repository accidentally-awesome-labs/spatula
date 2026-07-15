import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import {
  ValidationSchemaError,
  ValidationParamsError,
} from '@accidentally-awesome-labs/spatula-shared';

export function validateBody<T extends z.ZodType>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);

    if (!result.success) {
      throw new ValidationSchemaError(
        `Invalid request body: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        { context: { issues: result.error.issues } },
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
      throw new ValidationParamsError(
        `Invalid query parameters: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        { context: { issues: result.error.issues } },
      );
    }

    c.set('validatedQuery', result.data);
    return next();
  };
}
