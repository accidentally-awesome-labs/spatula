import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function adminSystemRoutes() {
  const app = new Hono<AppEnv>();

  // GET /health — detailed system health
  app.get('/health', async (c) => {
    const deps = c.get('deps');

    // Postgres check
    let postgresStatus = 'ok';
    try {
      await deps.dbPool.query('SELECT 1');
    } catch {
      postgresStatus = 'error';
    }

    // Redis check
    let redisStatus = 'not_configured';
    if (deps.redis) {
      try {
        await deps.redis.ping();
        redisStatus = 'ok';
      } catch {
        redisStatus = 'error';
      }
    }

    // Queue health
    const queues: Record<string, unknown> = {};
    if (deps.queues) {
      const queueNames = [
        'crawl',
        'extract',
        'schemaEvolution',
        'reconciliation',
        'export',
        'webhook',
      ] as const;
      for (const name of queueNames) {
        try {
          const counts = await deps.queues[name].getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          queues[name] = counts;
        } catch {
          queues[name] = { error: 'unavailable' };
        }
      }
    }

    // Pool stats
    const pool = {
      total: (deps.dbPool as any).totalCount ?? 0,
      idle: (deps.dbPool as any).idleCount ?? 0,
      waiting: (deps.dbPool as any).waitingCount ?? 0,
    };

    const mem = process.memoryUsage();

    return c.json({
      data: {
        postgres: postgresStatus,
        redis: redisStatus,
        queues,
        pool,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      },
    });
  });

  // GET /metrics — key business metrics
  app.get('/metrics', async (c) => {
    const deps = c.get('deps');

    const [totalTenants, activeJobs, dlqDepth, totalStorageBytes] = await Promise.all([
      deps.tenantRepo ? deps.tenantRepo.countAll() : 0,
      deps.jobRepo.countAll({ status: 'running' as any }),
      deps.dlqRepo ? deps.dlqRepo.countUnresolved() : 0,
      deps.tenantRepo?.getTotalStorage ? deps.tenantRepo.getTotalStorage() : 0,
    ]);

    const queues: Record<string, unknown> = {};
    if (deps.queues) {
      const queueNames = [
        'crawl',
        'extract',
        'schemaEvolution',
        'reconciliation',
        'export',
        'webhook',
      ] as const;
      for (const name of queueNames) {
        try {
          const counts = await deps.queues[name].getJobCounts('waiting', 'active', 'failed');
          queues[name] = counts;
        } catch {
          queues[name] = { error: 'unavailable' };
        }
      }
    }

    return c.json({
      data: { totalTenants, activeJobs, totalStorageBytes, dlqDepth, queues },
    });
  });

  return app;
}
