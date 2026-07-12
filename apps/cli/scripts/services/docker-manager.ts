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
const COMPOSE_PATH = join(__dirname, '..', '..', 'tests', 'e2e', 'tier4', 'docker-compose.yml');

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
function compose(projectName: string, args: string[], opts?: { timeout?: number }): string {
  return execFileSync('docker', ['compose', '-p', projectName, '-f', COMPOSE_PATH, ...args], {
    stdio: 'pipe',
    timeout: opts?.timeout ?? 30_000,
    encoding: 'utf-8',
  });
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
    const port = process.env.TEST_POSTGRES_PORT ?? '5433';
    const connectionString = `postgres://spatula:spatula_test@localhost:${port}/spatula_test`;

    // Check if Postgres is already reachable on the expected port
    const alreadyRunning = await this.isPostgresReachable(port);

    let weStartedIt = false;
    if (!alreadyRunning) {
      this.projectName = `spatula-test-${randomBytes(4).toString('hex')}`;
      compose(this.projectName, ['up', '-d', 'postgres']);
      weStartedIt = true;

      await pollUntil(
        () => {
          try {
            const output = compose(this.projectName, ['ps', '--format', 'json']);
            return output.includes('"healthy"') || output.includes('(healthy)');
          } catch {
            return false;
          }
        },
        { timeoutMs: 30_000, intervalMs: 1_000, label: 'Postgres healthy' },
      );
    } else {
      console.log('  docker-postgres: reusing existing container on port ' + port);
    }

    // Run database migrations
    // NOTE: We call drizzle-orm migrate directly instead of @spatula/db's
    // runMigrations because the latter resolves migration paths relative to
    // its own __dirname, which breaks when called via tsx from a different package.
    const { resolve: pathResolve } = await import('node:path');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { createDatabasePool } = await import('@spatula/db');
    const migrationsDb = createDatabasePool(connectionString);
    // Find monorepo root by walking up from this file
    const { dirname: pathDirname } = await import('node:path');
    const { fileURLToPath: toPath } = await import('node:url');
    const thisDir = pathDirname(toPath(import.meta.url));
    // thisDir = apps/cli/scripts/services → root = ../../../../
    const monorepoRoot = pathResolve(thisDir, '..', '..', '..', '..');
    const migrationsFolder = pathResolve(monorepoRoot, 'packages', 'db', 'drizzle');
    try {
      await migrate(migrationsDb.db, {
        migrationsFolder,
        migrationsTable: '__drizzle_migrations_oss',
      });
    } finally {
      await migrationsDb.pool.end();
    }

    const projectName = this.projectName;

    return {
      async stop() {
        if (weStartedIt && projectName) {
          try {
            compose(projectName, ['down', '--volumes', '--remove-orphans'], { timeout: 30_000 });
          } catch {
            /* Best-effort cleanup */
          }
        }
        // If we didn't start it, don't stop it (user manages their own containers)
      },
      connectionInfo: { host: 'localhost', port: Number(port), database: 'spatula_test' },
      envVars: { DATABASE_URL: connectionString },
    };
  }

  private async isPostgresReachable(port: string): Promise<boolean> {
    try {
      const net = await import('node:net');
      return new Promise((resolve) => {
        const socket = net.createConnection({ host: 'localhost', port: Number(port) }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
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
    const port = process.env.TEST_REDIS_PORT ?? '6380';
    const redisUrl = `redis://localhost:${port}/1`;

    // Check if Redis is already reachable
    const alreadyRunning = await this.isRedisReachable(port);

    let weStartedIt = false;
    if (!alreadyRunning) {
      this.projectName = `spatula-test-${randomBytes(4).toString('hex')}`;
      compose(this.projectName, ['up', '-d', 'redis']);
      weStartedIt = true;

      await pollUntil(
        () => {
          try {
            const output = compose(this.projectName, ['ps', '--format', 'json']);
            return output.includes('"healthy"') || output.includes('(healthy)');
          } catch {
            return false;
          }
        },
        { timeoutMs: 15_000, intervalMs: 1_000, label: 'Redis healthy' },
      );
    } else {
      console.log('  docker-redis: reusing existing container on port ' + port);
    }

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
        if (weStartedIt && projectName) {
          try {
            compose(projectName, ['down', '--volumes', '--remove-orphans'], { timeout: 30_000 });
          } catch {
            // Best-effort cleanup
          }
        }
      },
      connectionInfo: { host: 'localhost', port: Number(port), db: 1 },
      envVars: { REDIS_URL: redisUrl },
    };
  }

  private async isRedisReachable(port: string): Promise<boolean> {
    try {
      const net = await import('node:net');
      return new Promise((resolve) => {
        const socket = net.createConnection({ host: 'localhost', port: Number(port) }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    const port = process.env.TEST_REDIS_PORT ?? '6380';
    return this.isRedisReachable(port);
  }
}
