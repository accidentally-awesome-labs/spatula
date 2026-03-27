import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { SpatulaQueues } from '@spatula/queue';

export function createQueueDashboard(queues: SpatulaQueues) {
  const serverAdapter = new HonoAdapter(serveStatic).setBasePath('/api/v1/admin/queues');

  const queueAdapters = [
    new BullMQAdapter(queues.crawl),
    new BullMQAdapter(queues.schemaEvolution),
    new BullMQAdapter(queues.reconciliation),
    new BullMQAdapter(queues.export),
  ];

  // Add extract queue if it exists on the type
  if ('extract' in queues && queues.extract) {
    queueAdapters.splice(1, 0, new BullMQAdapter(queues.extract));
  }

  createBullBoard({ queues: queueAdapters, serverAdapter });

  return serverAdapter.registerPlugin();
}
