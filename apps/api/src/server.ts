import { serve } from '@hono/node-server';
import { createLogger } from '@spatula/shared';
import { createApp } from './app.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:server');

export function startServer(deps: AppDeps, port = 3000) {
  const app = createApp(deps);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  logger.info({ port }, 'API server started');
  return server;
}
