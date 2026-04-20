import { describe, it, expect, vi } from 'vitest';
import { getTotalQueueDepth } from '../../src/server.js';

function makeQueue(counts: Partial<Record<string, number>>) {
  return {
    getJobCounts: vi.fn().mockResolvedValue(counts),
  } as any;
}

function makeFailingQueue() {
  return {
    getJobCounts: vi.fn().mockRejectedValue(new Error('redis down')),
  } as any;
}

function buildQueues(overrides: Record<string, any> = {}) {
  const defaults = {
    crawl: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
    extract: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
    schemaEvolution: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
    reconciliation: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
    export: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
    webhook: makeQueue({ waiting: 0, active: 0, delayed: 0 }),
  };
  return { ...defaults, ...overrides } as any;
}

describe('getTotalQueueDepth', () => {
  it('returns 0 when queues are undefined', async () => {
    expect(await getTotalQueueDepth(undefined)).toBe(0);
  });

  it('sums waiting + active + delayed across all queues', async () => {
    const queues = buildQueues({
      crawl: makeQueue({ waiting: 3, active: 1, delayed: 2 }), // 6
      extract: makeQueue({ waiting: 5, active: 0, delayed: 0 }), // 5
      export: makeQueue({ waiting: 0, active: 2, delayed: 1 }), // 3
    });
    expect(await getTotalQueueDepth(queues)).toBe(14);
  });

  it('ignores completed and failed counts even if returned', async () => {
    const queues = buildQueues({
      crawl: makeQueue({ waiting: 1, active: 1, delayed: 1, completed: 100, failed: 50 }),
    });
    expect(await getTotalQueueDepth(queues)).toBe(3);
  });

  it('requests only the three states it needs', async () => {
    const queue = makeQueue({ waiting: 1, active: 0, delayed: 0 });
    const queues = buildQueues({ crawl: queue });
    await getTotalQueueDepth(queues);
    expect(queue.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed');
  });

  it('tolerates per-queue getJobCounts failures (one redis hiccup does not zero the gauge)', async () => {
    const queues = buildQueues({
      crawl: makeFailingQueue(),
      extract: makeQueue({ waiting: 7, active: 0, delayed: 0 }),
    });
    // crawl throws → 0, extract → 7, others → 0. No unhandled rejection.
    expect(await getTotalQueueDepth(queues)).toBe(7);
  });

  it('handles missing fields in getJobCounts response', async () => {
    const queues = buildQueues({
      crawl: makeQueue({ waiting: 2 }), // active, delayed absent
    });
    expect(await getTotalQueueDepth(queues)).toBe(2);
  });
});
