import type { HealthCheck, HealthCheckResult } from './health-check.js';

export interface ServerCheckConfig {
  /** Test database connectivity. Caller provides the implementation (avoids pg/ioredis dependency in core). */
  checkPostgres?: () => Promise<HealthCheckResult>;
  /** Test Redis connectivity. */
  checkRedis?: () => Promise<HealthCheckResult>;
  apiUrl?: string;
  /** Test migration state. */
  checkMigrations?: () => Promise<HealthCheckResult>;
}

export function createServerChecks(config: ServerCheckConfig): HealthCheck[] {
  return [
    {
      name: 'postgres',
      category: 'server',
      async run() {
        if (!config.checkPostgres) {
          const url = process.env.DATABASE_URL;
          if (!url) return { status: 'fail', message: 'DATABASE_URL not configured' };
          return { status: 'warn', message: 'DATABASE_URL set but no connection tester provided' };
        }
        return config.checkPostgres();
      },
    },
    {
      name: 'redis',
      category: 'server',
      async run() {
        if (!config.checkRedis) {
          const url = process.env.REDIS_URL;
          if (!url) return { status: 'fail', message: 'REDIS_URL not configured' };
          return { status: 'warn', message: 'REDIS_URL set but no connection tester provided' };
        }
        return config.checkRedis();
      },
    },
    {
      name: 'api-server',
      category: 'server',
      async run() {
        const url = config.apiUrl ?? process.env.API_URL ?? 'http://localhost:3000';
        try {
          const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) return { status: 'pass', message: 'API server is ready' };
          return { status: 'fail', message: `API server returned ${res.status}` };
        } catch (err) {
          return { status: 'fail', message: `API server: ${(err as Error).message}` };
        }
      },
    },
    {
      name: 'migrations',
      category: 'server',
      async run() {
        if (!config.checkMigrations) {
          return { status: 'warn', message: 'No migration checker provided' };
        }
        return config.checkMigrations();
      },
    },
  ];
}
