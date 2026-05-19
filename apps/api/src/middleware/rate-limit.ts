import type { MiddlewareHandler } from 'hono';
import type Redis from 'ioredis';
import { ErrorCode } from '@spatula/shared';
import { lookupRateLimit } from './rate-limit-config.js';

const WINDOW_MS = 60_000;

/**
 * Walk `c.req.matchedRoutes` and return the most-specific route template (the
 * last non-wildcard entry). Returns null when no concrete route was matched.
 *
 * Rationale: Hono's `c.req.routePath` returns the path of the CURRENTLY
 * executing handler (the middleware itself in our case → `/*` or similar).
 * `matchedRoutes` contains every route in the matched chain in registration
 * order; the LAST non-wildcard entry is the eventual handler.
 */
function resolveMatchedRoutePath(c: {
  req: { matchedRoutes?: Array<{ path: string }> };
}): string | null {
  const routes = c.req.matchedRoutes;
  if (!routes || routes.length === 0) return null;
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i].path;
    if (!path.includes('*')) return path;
  }
  return null;
}

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

/**
 * Per-tenant sliding-window rate-limit middleware (Phase 16 plan 16-1).
 *
 * Emits the full v1 header set on every request:
 *   - `X-RateLimit-Limit`     — configured cap for this route
 *   - `X-RateLimit-Remaining` — count remaining before throttling
 *   - `X-RateLimit-Reset`     — epoch seconds when the window expires (NEW)
 *
 * On 429:
 *   - `Retry-After: 60`       — RFC 7231 §7.1.3 seconds-form
 *   - envelope `code: ErrorCode.RATE_LIMIT_EXCEEDED` ('RATE_LIMIT.EXCEEDED')
 *   - envelope `details: { limit, resetAt }` — surfaced for SDK consumers
 *
 * The cap is looked up per `${METHOD} ${routePath}` against
 * `config/rate-limits.yaml` (loaded once at boot); unmatched routes fall back
 * to `default`. See `rate-limit-config.ts` for the loader.
 */
export function rateLimitMiddleware(redis: Redis): MiddlewareHandler {
  return async (c, next) => {
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) return next();

    // Resolve the matched-handler route template (e.g., `/api/v1/jobs/:id`).
    // `c.req.routePath` from inside an `app.use('*', ...)` middleware returns
    // the middleware's own registration path (`/*`), not the downstream handler
    // — so we walk `matchedRoutes` and pick the most-specific non-wildcard entry.
    const routePath = resolveMatchedRoutePath(c) ?? c.req.path;
    const cfg = lookupRateLimit(c.req.method, routePath);

    if (cfg.requestsPerMinute === Infinity) return next();

    const now = Date.now();
    const resetEpochSeconds = Math.floor((now + WINDOW_MS) / 1000);
    const key = `ratelimit:${tenantId}:${WINDOW_MS}`;
    const member = `${now}:${crypto.randomUUID()}`;

    // redis.eval() runs a server-side Lua script atomically — NOT JS eval.
    const result = await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      now.toString(),
      WINDOW_MS.toString(),
      cfg.requestsPerMinute.toString(),
      member,
    );
    const [accepted, count] = result as [number, number];

    c.header('X-RateLimit-Limit', cfg.requestsPerMinute.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, cfg.requestsPerMinute - count).toString());
    c.header('X-RateLimit-Reset', resetEpochSeconds.toString());

    if (!accepted) {
      // Return 429 directly (don't throw) to preserve Retry-After header
      c.header('Retry-After', '60');
      return c.json(
        {
          error: {
            code: ErrorCode.RATE_LIMIT_EXCEEDED,
            message: 'Rate limit exceeded',
            requestId: c.get('requestId') ?? '',
            details: { limit: cfg.requestsPerMinute, resetAt: resetEpochSeconds },
          },
        },
        429,
      );
    }

    await next();
  };
}
