import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './types.js';

export function createOpenAPIRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(', '),
              requestId,
            },
          },
          400,
        );
      }
    },
  });
}
