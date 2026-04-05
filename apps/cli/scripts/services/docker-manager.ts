// ---------------------------------------------------------------------------
// Docker-based ServiceManagers for Postgres and Redis
// ---------------------------------------------------------------------------
// Uses docker compose to spin up ephemeral test containers.
// Each start() call generates a unique project name so parallel test runs
// don't collide.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  ServiceManager,
  ServiceStatus,
  ProvisionOpts,
  ServiceContext,
  ServiceHandle,
} from './service-manager.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Absolute path to the docker-compose.yml shared by both managers.
 * Resolved relative to *this* file's location at runtime.
 */
const COMPOSE_PATH = join(
  __dirname,
  '..',
  '..',
  'tests',
  'e2e',
  'tier4',
  'docker-compose.yml',
);

/** Check that Docker (with compose v2) is reachable. */
function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
    execFileSync('docker', ['compose', 'version'], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Run a docker compose command against the shared compose file. */
function compose(
  projectName: string,
  args: string[],
  opts?: { timeout?: number },
): string {
  return execFileSync(
    'docker',
    ['compose', '-p', projectName, '-f', COMPOSE_PATH, ...args],
    {
      stdio: 'pipe',
      timeout: opts?.timeout ?? 30_000,
      encoding: 'utf-8',
    },
  );
}

/**
 * Poll until `predicate` returns true, or throw after `timeoutMs`.
 * Polls every `intervalMs` milliseconds.
 */
async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Swallow — keep polling
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`Timed out waiting for ${opts.label} (${opts.timeoutMs}ms)`);
}

// ---------------------------------------------------------------------------
// DockerPostgresManager
// ---------------------------------------------------------------------------

export class DockerPostgresManager implements ServiceManager {
  readonly name = 'docker-postgres';
  private projectName = '';

  async check(): Promise<ServiceStatus> {
    const available = isDockerAvailable();
    return {
      available,
      details: { docker: available },
    };
  }

  async provision(opts: ProvisionOpts): Promise<boolean> {
    // We can't install Docker automatically — just verify it's present.
    return isDockerAvailable();
  }

  async start(context: ServiceContext): Promise<ServiceHandle> {
    this.projectName = `spatula-test-${randomBytes(4).toString('hex')}`;

    // Start only the postgres service
    compose(this.projectName, ['up', '-d', 'postgres']);

    // Poll until the container is healthy
    await pollUntil(
      () => {
        try {
          const output = compose(this.projectName, [
            'ps',
            '--format',
            'json',
          ]);
          // docker compose ps --format json may return one JSON object per
          // line or a JSON array depending on the version. We normalise to
          // a flat string search for robustness.
          return output.includes('"healthy"') || output.includes('(healthy)');
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, intervalMs: 1_000, label: 'Postgres healthy' },
    );

    const port = process.env.TEST_POSTGRES_PORT ?? '5433';
    const connectionString = `postgres://spatula:spatula_test@localhost:${port}/spatula_test`;

    // Run database migrations
    const { runMigrations } = await import('@spatula/db');
    await runMigrations(connectionString);

    const projectName = this.projectName;

    return {
      async stop() {
        try {
          compose(projectName, ['down', '--volumes', '--remove-orphans'], {
            timeout: 30_000,
          });
        } catch {
          // Best-effort cleanup
        }
      },
      connectionInfo: { host: 'localhost', port: Number(port), database: 'spatula_test' },
      envVars: { DATABASE_URL: connectionString },
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.projectName) return false;
    try {
      const output = compose(this.projectName, ['ps', '--format', 'json']);
      return output.includes('"healthy"') || output.includes('(healthy)');
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// DockerRedisManager
// ---------------------------------------------------------------------------

export class DockerRedisManager implements ServiceManager {
  readonly name = 'docker-redis';
  private projectName = '';

  async check(): Promise<ServiceStatus> {
    const available = isDockerAvailable();
    return {
      available,
      details: { docker: available },
    };
  }

  async provision(opts: ProvisionOpts): Promise<boolean> {
    return isDockerAvailable();
  }

  async start(context: ServiceContext): Promise<ServiceHandle> {
    this.projectName = `spatula-test-${randomBytes(4).toString('hex')}`;

    // Start only the redis service
    compose(this.projectName, ['up', '-d', 'redis']);

    // Poll until the container is healthy
    await pollUntil(
      () => {
        try {
          const output = compose(this.projectName, [
            'ps',
            '--format',
            'json',
          ]);
          return output.includes('"healthy"') || output.includes('(healthy)');
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, intervalMs: 1_000, label: 'Redis healthy' },
    );

    const port = process.env.TEST_REDIS_PORT ?? '6380';
    const redisUrl = `redis://localhost:${port}/1`;

    // Connect to Redis, select DB 1, and flush it for a clean test slate
    const { default: Redis } = await import('ioredis');
    const client = new Redis({ host: 'localhost', port: Number(port), db: 1 });
    try {
      await client.flushdb();
    } finally {
      client.disconnect();
    }

    const projectName = this.projectName;

    return {
      async stop() {
        try {
          compose(projectName, ['down', '--volumes', '--remove-orphans'], {
            timeout: 30_000,
          });
        } catch {
          // Best-effort cleanup
        }
      },
      connectionInfo: { host: 'localhost', port: Number(port), db: 1 },
      envVars: { REDIS_URL: redisUrl },
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.projectName) return false;
    try {
      const output = compose(this.projectName, ['ps', '--format', 'json']);
      return output.includes('"healthy"') || output.includes('(healthy)');
    } catch {
      return false;
    }
  }
}
