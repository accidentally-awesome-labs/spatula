import { createLogger, shutdownMetrics, shutdownTracing } from '@spatula/shared';
import type { ServerType } from '@hono/node-server';
import type { AppDeps } from './types.js';
import type { JobProgressManager } from './ws/job-progress.js';

const logger = createLogger('api:shutdown');

export const SHUTDOWN_TIMEOUT_MS = 25_000; // 25s — leaves 5s buffer before k8s SIGKILL at 30s

/**
 * Execute the shutdown sequence. Exported for testing.
 * The signal handler registration stays in server.ts.
 */
export async function executeShutdown(
  server: ServerType,
  deps: AppDeps,
  progressManager?: JobProgressManager,
): Promise<void> {
  // 1. Stop accepting new connections and drain in-flight requests
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // 2. Close WebSocket connections
  if (progressManager) {
    progressManager.closeAll();
  }

  // 3. Close Redis subscriber
  if (deps.redisSubscriber) {
    await deps.redisSubscriber.quit();
  }

  // 4. Close database pool
  if (deps.dbPool) {
    await deps.dbPool.end();
  }

  // 5. Flush OTel buffered spans and stop Prometheus HTTP server
  await shutdownTracing();
  await shutdownMetrics();

  logger.info('Shutdown complete');
}
