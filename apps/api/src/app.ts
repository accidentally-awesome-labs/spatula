import { Hono } from 'hono';
import { errorHandler } from './middleware/error-handler.js';
import type { AppEnv } from './types.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Error handler
  app.onError(errorHandler);

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  return app;
}
