import { describe, it, expect, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name, opts) => ({
    name,
    opts,
    add: vi.fn(),
    close: vi.fn(),
  })),
}));

import {
  createQueues,
  QUEUE_NAMES,
  DEFAULT_QUEUE_CONFIG,
  redisConnectionOptionsFromUrl,
} from '../../src/queues.js';

describe('Queue Factory', () => {
  it('exports queue name constants', () => {
    expect(QUEUE_NAMES.CRAWL).toBe('spatula.crawl');
    expect(QUEUE_NAMES.EXTRACT).toBe('spatula.extract');
    expect(QUEUE_NAMES.SCHEMA_EVOLUTION).toBe('spatula.schema-evolution');
    expect(QUEUE_NAMES.RECONCILIATION).toBe('spatula.reconciliation');
  });

  it('creates all queues', () => {
    const queues = createQueues({ host: 'localhost', port: 6379 });
    expect(queues.crawl).toBeDefined();
    expect(queues.extract).toBeDefined();
    expect(queues.schemaEvolution).toBeDefined();
    expect(queues.reconciliation).toBeDefined();
  });

  it('passes Redis connection to queues', () => {
    const connection = { host: 'localhost', port: 6379 };
    const queues = createQueues(connection);
    expect(queues.crawl.opts.connection).toEqual(connection);
  });

  it('closeAll closes all queues', async () => {
    const queues = createQueues({ host: 'localhost', port: 6379 });
    await queues.closeAll();
    expect(queues.crawl.close).toHaveBeenCalled();
    expect(queues.extract.close).toHaveBeenCalled();
    expect(queues.schemaEvolution.close).toHaveBeenCalled();
    expect(queues.reconciliation.close).toHaveBeenCalled();
  });

  it('accepts QueueConfig and applies defaultJobOptions', () => {
    const config = {
      crawl: { concurrency: 5, rateLimitMax: 10, rateLimitDuration: 1000 },
      extract: { concurrency: 3 },
      schemaEvolution: { concurrency: 1 },
      reconciliation: { concurrency: 1 },
      export: { concurrency: 2 },
    };
    const result = createQueues({ host: 'localhost', port: 6379 }, config);
    expect(result.config).toEqual(config);
  });

  it('uses default config when none provided', () => {
    const result = createQueues({ host: 'localhost', port: 6379 });
    expect(result.config).toBeDefined();
    expect(result.config.crawl.concurrency).toBe(5);
    expect(result.config.schemaEvolution.concurrency).toBe(1);
  });

  it('parses Redis URL connection options without a DB path', () => {
    expect(redisConnectionOptionsFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
    });
  });

  it('preserves Redis DB selection for BullMQ connections', () => {
    expect(redisConnectionOptionsFromUrl('redis://user:p%40ss@localhost:6380/15')).toEqual({
      host: 'localhost',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 15,
    });
  });

  it('rejects invalid Redis DB paths', () => {
    expect(() => redisConnectionOptionsFromUrl('redis://localhost:6379/not-a-db')).toThrow(
      'Invalid Redis database',
    );
  });
});
