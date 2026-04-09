import { describe, it, expect, vi } from 'vitest';

// Mock Bull Board dependencies before importing the module
vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn(),
}));
vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn().mockImplementation((queue: any) => ({ queue })),
}));
vi.mock('@bull-board/hono', () => ({
  HonoAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn().mockReturnThis(),
    registerPlugin: vi.fn().mockReturnValue(new (require('hono').Hono)()),
  })),
}));
vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: vi.fn(),
}));

import { createQueueDashboard } from '../../../src/routes/admin-queues.js';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

describe('createQueueDashboard', () => {
  function mockQueues() {
    return {
      crawl: { name: 'spatula.crawl' },
      extract: { name: 'spatula.extract' },
      schemaEvolution: { name: 'spatula.schema-evolution' },
      reconciliation: { name: 'spatula.reconciliation' },
      export: { name: 'spatula.export' },
      webhook: { name: 'spatula.webhook' },
    } as any;
  }

  it('creates Bull Board with all 6 queue adapters', () => {
    const queues = mockQueues();
    createQueueDashboard(queues);

    expect(BullMQAdapter).toHaveBeenCalledTimes(6);
    expect(BullMQAdapter).toHaveBeenCalledWith(queues.crawl);
    expect(BullMQAdapter).toHaveBeenCalledWith(queues.export);
    expect(BullMQAdapter).toHaveBeenCalledWith(queues.webhook);
  });

  it('passes all adapters to createBullBoard', () => {
    createQueueDashboard(mockQueues());

    expect(createBullBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        queues: expect.arrayContaining([
          expect.objectContaining({ queue: expect.objectContaining({ name: 'spatula.crawl' }) }),
        ]),
      }),
    );
  });
});
