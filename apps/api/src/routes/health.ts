import { Hono } from 'hono';
import type { Pool } from 'pg';
import type Redis from 'ioredis';

export interface HealthDeps {
  dbPool?: Pool;
  redis?: Redis;
  queues?: { crawl?: { getJobCounts: () => Promise<Record<string, number>> } };
}

// Health routes receive deps directly (not via c.get('deps')) because they
// mount before depsMiddleware in the chain — they need to work without auth.
export function healthRoutes(deps: HealthDeps) {
  const app = new Hono();

  app.get('/health/live', (c) => c.json({ status: 'ok' }));

  app.get('/health/ready', async (c) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    const results = await Promise.allSettled([
      deps.dbPool ? deps.dbPool.query('SELECT 1').then(() => { checks.database = 'ok'; }) : Promise.resolve().then(() => { checks.database = 'ok'; }),
      deps.redis ? deps.redis.ping().then(() => { checks.redis = 'ok'; }) : Promise.resolve().then(() => { checks.redis = 'ok'; }),
      deps.queues?.crawl ? deps.queues.crawl.getJobCounts().then(() => { checks.queue = 'ok'; }) : Promise.resolve().then(() => { checks.queue = 'ok'; }),
    ]);

    if (results[0].status === 'rejected') checks.database = 'fail';
    if (results[1].status === 'rejected') checks.redis = 'fail';
    if (results[2].status === 'rejected') checks.queue = 'fail';

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503 as any);
  });

  return app;
}
