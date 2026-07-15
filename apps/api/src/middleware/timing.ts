import type { MiddlewareHandler } from 'hono';
import type { SpatulaMetrics } from '@accidentally-awesome-labs/spatula-shared';

export function timingMiddleware(metrics: SpatulaMetrics | null): MiddlewareHandler {
  return async (c, next) => {
    if (!metrics) return next();

    const start = performance.now();
    metrics.httpActiveConnections.add(1);

    try {
      await next();
    } finally {
      const duration = performance.now() - start;
      const attrs = {
        method: c.req.method,
        route: c.req.routePath ?? c.req.path,
        status: c.res.status,
      };
      metrics.httpRequestDuration.record(duration, attrs);
      metrics.httpRequestsTotal.add(1, attrs);
      metrics.httpActiveConnections.add(-1);
    }
  };
}
