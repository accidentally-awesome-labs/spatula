import type { MiddlewareHandler } from 'hono';
import { createLogger } from '@spatula/shared';

const logger = createLogger('idempotency');
const IDEMPOTENCY_TTL = 86400; // 24 hours

export function idempotencyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'POST' && c.req.method !== 'PATCH') return next();

    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) return next();

    // Validate key format and length
    if (idempotencyKey.length > 255) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Idempotency-Key must be 255 characters or less', requestId: '' } }, 400);
    }

    const redis = c.get('deps')?.redis;
    if (!redis) return next();

    const tenantId = c.get('tenantId') ?? 'unknown';
    const cacheKey = `idempotency:${tenantId}:${idempotencyKey}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const { statusCode, body } = JSON.parse(cached);
        logger.debug({ cacheKey }, 'Returning cached idempotent response');
        return c.json(body, statusCode);
      }
    } catch (err) {
      logger.warn({ err, cacheKey }, 'Idempotency cache read failed');
    }

    await next();

    // Only cache 2xx responses
    try {
      const status = c.res.status;
      if (status < 200 || status >= 300) return;
      const contentType = c.res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) return; // Only cache JSON responses
      const cloned = c.res.clone();
      const body = await cloned.json();
      await redis.set(cacheKey, JSON.stringify({ statusCode: status, body }), 'EX', IDEMPOTENCY_TTL);
    } catch (err) {
      logger.warn({ err, cacheKey }, 'Idempotency cache write failed');
    }
  };
}
