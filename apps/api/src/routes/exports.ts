import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function exportRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/export', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Export will be implemented in Phase 10' } },
      501 as any,
    );
  });

  router.get('/export/:exportId', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Export download will be implemented in Phase 10' } },
      501 as any,
    );
  });

  router.get('/documentation', (c) => {
    return c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'Documentation will be implemented in Phase 10' } },
      501 as any,
    );
  });

  return router;
}
