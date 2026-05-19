import { OpenAPIHono } from '@hono/zod-openapi';
import { ErrorCode } from '@spatula/shared';
import type { AppEnv } from './types.js';

export function createOpenAPIRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
        return c.json(
          {
            error: {
              // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'VALIDATION_ERROR').
              code: ErrorCode.VALIDATION_SCHEMA,
              message: result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(', '),
              requestId,
              details: { issues: result.error.issues },
            },
          },
          400,
        );
      }
    },
  });
}
