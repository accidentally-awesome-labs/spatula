import type { MiddlewareHandler } from 'hono';
import type Redis from 'ioredis';
import { RATE_LIMIT_TIERS } from '@spatula/shared';

const WINDOW_MS = 60_000;

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  return {0, count}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
return {1, count + 1}
`;

export function rateLimitMiddleware(redis: Redis): MiddlewareHandler {
  return async (c, next) => {
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) return next();

    const tierName = (c.get('rateLimitTier') as string) ?? 'free';
    const tier = RATE_LIMIT_TIERS[tierName] ?? RATE_LIMIT_TIERS.free;

    if (tier.requestsPerMinute === Infinity) return next();

    const now = Date.now();
    const key = `ratelimit:${tenantId}:${WINDOW_MS}`;
    const member = `${now}:${crypto.randomUUID()}`;

    // redis.eval() executes a Lua script atomically on the Redis server — not JS eval
    const result = await redis.eval(
      RATE_LIMIT_SCRIPT, 1, key,
      now.toString(), WINDOW_MS.toString(),
      tier.requestsPerMinute.toString(), member,
    );
    const [accepted, count] = result as [number, number];

    c.header('X-RateLimit-Limit', tier.requestsPerMinute.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, tier.requestsPerMinute - count).toString());

    if (!accepted) {
      // Return 429 directly (don't throw) to preserve Retry-After header
      c.header('Retry-After', '60');
      return c.json({
        error: {
          code: 'RATE_LIMIT_ERROR',
          message: 'Rate limit exceeded',
          requestId: c.get('requestId') ?? '',
        },
      }, 429);
    }

    await next();
  };
}
