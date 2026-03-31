import type { MiddlewareHandler } from 'hono';
import { createLogger } from '@spatula/shared';

const logger = createLogger('timeout');

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
      timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    });

    try {
      await Promise.race([next(), timeoutPromise]);
    } catch (err) {
      if ((err as Error).message === 'TIMEOUT') {
        logger.warn({ path, timeoutMs }, 'request timed out');
        const requestId = c.get('requestId') ?? '';
        return c.json(
          { error: { code: 'TIMEOUT', message: `Request timed out after ${timeoutMs}ms`, requestId } },
          504,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
