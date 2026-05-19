import type { MiddlewareHandler } from 'hono';
import { createLogger, ErrorCode } from '@spatula/shared';

const logger = createLogger('timeout');

class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`);
  }
}

export interface TimeoutConfig {
  defaultMs: number;
  overrides?: Record<string, number>;
}

export function timeoutMiddleware(config: TimeoutConfig): MiddlewareHandler {
  const { defaultMs, overrides = {} } = config;

  // Pre-compile override patterns for efficiency
  const compiledOverrides = Object.entries(overrides).map(([pattern, ms]) => ({
    regex: new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$'),
    ms,
  }));

  return async (c, next) => {
    const path = c.req.path;
    const timeoutMs = compiledOverrides.find((o) => o.regex.test(path))?.ms ?? defaultMs;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
      await Promise.race([next(), timeoutPromise]);
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        logger.warn({ path, timeoutMs }, 'request timed out');
        const requestId = c.get('requestId') ?? '';
        return c.json(
          {
            // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'TIMEOUT').
            error: {
              code: ErrorCode.INTERNAL_TIMEOUT,
              message: err.message,
              requestId,
              details: { timeoutMs, path },
            },
          },
          504,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
