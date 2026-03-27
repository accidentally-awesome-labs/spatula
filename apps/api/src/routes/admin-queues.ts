import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { SpatulaQueues } from '@spatula/queue';

export function createQueueDashboard(queues: SpatulaQueues) {
  const serverAdapter = new HonoAdapter(serveStatic).setBasePath('/api/v1/admin/queues');

  const queueAdapters = [
    new BullMQAdapter(queues.crawl),
    new BullMQAdapter(queues.extract),
    new BullMQAdapter(queues.schemaEvolution),
    new BullMQAdapter(queues.reconciliation),
    new BullMQAdapter(queues.export),
  ];

  createBullBoard({ queues: queueAdapters, serverAdapter });

  return serverAdapter.registerPlugin();
}
