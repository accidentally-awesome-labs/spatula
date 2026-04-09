import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createLogger, loadConfig, getEnvOrDefault, registerGauges } from '@spatula/shared';
import { createApp } from './app.js';
import { JobProgressManager } from './ws/job-progress.js';
import { executeShutdown, SHUTDOWN_TIMEOUT_MS } from './shutdown.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:server');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setupGracefulShutdown(
  server: ServerType,
  deps: AppDeps,
  progressManager?: JobProgressManager,
): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, draining connections');

    // Force exit after timeout
    const forceTimer = setTimeout(() => {
      logger.warn('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref(); // Don't keep process alive just for this timer

    try {
      await executeShutdown(server, deps, progressManager);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export function startServer(deps: AppDeps, port?: number) {
  const config = loadConfig();
  const serverPort = port ?? config.server.port;

  // Register observable gauges now that repos are available
  if (deps.jobRepo && deps.tenantRepo) {
    registerGauges({
      jobRepo: { countByStatus: (status: string) => deps.jobRepo.countByTenant('*', { status }) },
      tenantRepo: { countAll: () => deps.tenantRepo!.countAll() },
      queueProvider: { getQueueDepth: async () => 0 }, // TODO: wire to BullMQ queue depth
    });
  }

  const app = createApp(deps);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  let progressManager: JobProgressManager | undefined;

  // Mount WebSocket route when Redis subscriber is available
  if (deps.redisSubscriber) {
    progressManager = new JobProgressManager(deps.redisSubscriber);

    app.get(
      '/ws/jobs/:id/progress',
      upgradeWebSocket((c) => {
        const jobId = c.req.param('id')!;

        return {
          async onOpen(_evt, ws) {
            const authStrategy = getEnvOrDefault('AUTH_STRATEGY', 'none');
            let tenantId: string;

            if (authStrategy === 'none') {
              // Legacy: accept x-tenant-id header or ?tenantId= query param
              tenantId =
                c.req.header('x-tenant-id') ??
                new URL(c.req.url).searchParams.get('tenantId') ??
                '';
              if (!tenantId || !UUID_REGEX.test(tenantId)) {
                ws.close(4001, 'tenantId required (via x-tenant-id header or ?tenantId= query param)');
                return;
              }
            } else {
              // Token-based: validate ?token= against Redis
              const token = new URL(c.req.url).searchParams.get('token');
              if (!token) {
                ws.close(4001, 'WebSocket token required (use POST /api/v1/ws-token)');
                return;
              }
              if (!deps.redis) {
                ws.close(4500, 'Redis not available for token validation');
                return;
              }
              const key = `ws-token:${token}`;
              const value = await (deps.redis as any).getdel(key);
              if (!value) {
                ws.close(4001, 'Invalid or expired WebSocket token');
                return;
              }
              try {
                const parsed = JSON.parse(value);
                tenantId = parsed.tenantId;
              } catch {
                ws.close(4500, 'Corrupted token data');
                return;
              }
            }

            // Validate tenant owns this job
            try {
              const job = await deps.jobRepo.findById(jobId, tenantId);
              if (!job) {
                ws.close(4004, 'Job not found for tenant');
                return;
              }
            } catch (err) {
              logger.warn({ jobId, tenantId, err }, 'WS auth check failed');
              ws.close(4500, 'Internal error');
              return;
            }

            void progressManager!.addClient(jobId, tenantId, ws.raw as any);
          },
          onClose(_evt, ws) {
            void progressManager!.removeClient(jobId, ws.raw as any);
          },
        };
      }),
    );

    logger.info('WebSocket endpoint mounted at /ws/jobs/:id/progress');
  }

  const server = serve({
    fetch: app.fetch,
    port: serverPort,
  });

  injectWebSocket(server);
  setupGracefulShutdown(server, deps, progressManager);

  logger.info({ port: serverPort }, 'API server started');
  return server;
}
