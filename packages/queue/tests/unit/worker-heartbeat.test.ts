import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerHeartbeat } from '../../src/worker-heartbeat.js';

describe('WorkerHeartbeat', () => {
  let mockRedis: any;
  let heartbeat: WorkerHeartbeat;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRedis = { set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) };
    heartbeat = new WorkerHeartbeat({ redis: mockRedis, queues: ['spatula.crawl'] });
  });

  afterEach(() => {
    heartbeat.stop();
    vi.useRealTimers();
  });

  it('writes heartbeat to Redis on start', () => {
    heartbeat.start();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^worker:heartbeat:/),
      expect.any(String),
      'EX', 60,
    );
  });

  it('deletes heartbeat key on stop', () => {
    heartbeat.start();
    heartbeat.stop();
    expect(mockRedis.del).toHaveBeenCalledWith(expect.stringMatching(/^worker:heartbeat:/));
  });

  it('heartbeat value contains workerId, queues, pid', () => {
    heartbeat.start();
    const value = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(value.workerId).toBeDefined();
    expect(value.queues).toEqual(['spatula.crawl']);
    expect(value.pid).toBe(process.pid);
  });
});
