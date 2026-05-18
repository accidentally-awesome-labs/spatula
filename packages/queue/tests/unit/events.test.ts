import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisEventPublisher, channelForJob, NoopEventPublisher } from '../../src/events.js';
import type { JobEvent } from '../../src/events.js';

function createMockRedis() {
  return {
    publish: vi.fn().mockResolvedValue(1),
  };
}

describe('channelForJob', () => {
  it('returns spatula:events:{jobId}', () => {
    expect(channelForJob('job-123')).toBe('spatula:events:job-123');
  });
});

describe('RedisEventPublisher', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let publisher: RedisEventPublisher;

  beforeEach(() => {
    mockRedis = createMockRedis();
    publisher = new RedisEventPublisher(mockRedis as any);
  });

  it('publishes to spatula:events:{jobId} channel', async () => {
    await publisher.publish('job-123', {
      type: 'crawl_progress',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 3 },
    });

    expect(mockRedis.publish).toHaveBeenCalledWith('spatula:events:job-123', expect.any(String));
  });

  it('serializes event as JSON with timestamp', async () => {
    const before = Date.now();
    await publisher.publish('job-123', {
      type: 'task_completed',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: { taskId: 't-1', url: 'https://example.com', classification: 'single_entry' },
    });
    const after = Date.now();

    const payload = JSON.parse(mockRedis.publish.mock.calls[0][1]) as JobEvent;
    expect(payload.type).toBe('task_completed');
    expect(payload.jobId).toBe('job-123');
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
  });

  it('does not throw when publish fails', async () => {
    mockRedis.publish.mockRejectedValue(new Error('connection lost'));
    await expect(
      publisher.publish('job-123', {
        type: 'error',
        jobId: 'job-123',
        tenantId: 'tenant-1',
        data: { message: 'test' },
      }),
    ).resolves.toBeUndefined();
  });

  it('supports all event types', async () => {
    const types = [
      'crawl_progress',
      'task_completed',
      'schema_evolved',
      'action_pending',
      'job_status_changed',
      'entity_created',
      'error',
    ] as const;

    for (const type of types) {
      await publisher.publish('job-1', {
        type,
        jobId: 'job-1',
        tenantId: 't-1',
        data: {},
      });
    }

    expect(mockRedis.publish).toHaveBeenCalledTimes(types.length);
  });
});

describe('NoopEventPublisher', () => {
  it('does not throw', async () => {
    const publisher = new NoopEventPublisher();
    await expect(publisher.publish()).resolves.toBeUndefined();
  });
});
