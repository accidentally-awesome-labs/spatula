import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createLogger } from '@spatula/shared';
import { createApp } from './app.js';
import { JobProgressManager } from './ws/job-progress.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:server');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startServer(deps: AppDeps, port = 3000) {
  const app = createApp(deps);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Mount WebSocket route when Redis subscriber is available
  if (deps.redisSubscriber) {
    const progressManager = new JobProgressManager(deps.redisSubscriber);

    app.get(
      '/ws/jobs/:id/progress',
      upgradeWebSocket((c) => {
        const jobId = c.req.param('id');
        const tenantId = c.req.header('x-tenant-id') ?? '';

        return {
          async onOpen(_evt, ws) {
            // Validate tenant header
            if (!tenantId || !UUID_REGEX.test(tenantId)) {
              ws.close(4001, 'x-tenant-id header required');
              return;
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

            void progressManager.addClient(jobId, tenantId, ws.raw as any);
          },
          onClose(_evt, ws) {
            void progressManager.removeClient(jobId, ws.raw as any);
          },
        };
      }),
    );

    logger.info('WebSocket endpoint mounted at /ws/jobs/:id/progress');
  }

  const server = serve({
    fetch: app.fetch,
    port,
  });

  injectWebSocket(server);

  logger.info({ port }, 'API server started');
  return server;
}
