import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisEventPublisher, channelForJob, NoopEventPublisher } from '../../src/events.js';
import type { JobEvent } from '../../src/events.js';

function createMockRedis() {
  return {
    publish: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1748123456789-0'),
    expire: vi.fn().mockResolvedValue(1),
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

  // ── existing pub/sub tests (WS path — must not break) ────────────────────

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

  // ── NEW: Redis Stream (SSE path) dual-publish tests ──────────────────────

  it('writes to the Redis stream jobs:{jobId}:events after publish', async () => {
    await publisher.publish('job-123', {
      type: 'crawl_progress',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: { pagesFound: 10 },
    });

    // xadd must be called with MAXLEN ~ 500 auto-id and payload field
    expect(mockRedis.xadd).toHaveBeenCalledWith(
      'jobs:job-123:events',
      'MAXLEN',
      '~',
      '500',
      '*',
      'payload',
      expect.any(String),
    );

    // The payload stored in the stream must be the full JobEvent JSON
    const xaddArgs = mockRedis.xadd.mock.calls[0];
    const streamPayload = JSON.parse(xaddArgs[6]) as JobEvent;
    expect(streamPayload.type).toBe('crawl_progress');
    expect(streamPayload.jobId).toBe('job-123');
    expect(streamPayload.tenantId).toBe('tenant-1');
    expect(typeof streamPayload.timestamp).toBe('number');
  });

  it('refreshes the stream TTL to 300s after every xadd', async () => {
    await publisher.publish('job-123', {
      type: 'task_completed',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: {},
    });

    expect(mockRedis.expire).toHaveBeenCalledWith('jobs:job-123:events', 300);
  });

  it('does not propagate xadd errors — swallows them independently', async () => {
    mockRedis.xadd.mockRejectedValue(new Error('stream write failed'));
    await expect(
      publisher.publish('job-456', {
        type: 'job_status_changed',
        jobId: 'job-456',
        tenantId: 'tenant-2',
        data: { status: 'running' },
      }),
    ).resolves.toBeUndefined();
    // pub/sub must still have been called even though xadd throws
    expect(mockRedis.publish).toHaveBeenCalledOnce();
  });

  it('xadd still runs even when pub/sub publish fails (independent try/catch blocks)', async () => {
    mockRedis.publish.mockRejectedValue(new Error('pub/sub failure'));
    await publisher.publish('job-789', {
      type: 'entity_created',
      jobId: 'job-789',
      tenantId: 'tenant-3',
      data: {},
    });
    // xadd must still be called even though publish threw
    expect(mockRedis.xadd).toHaveBeenCalledOnce();
  });

  it('stream key uses jobs: prefix (distinct from spatula:events: pub/sub channel)', async () => {
    await publisher.publish('job-abc', {
      type: 'schema_evolved',
      jobId: 'job-abc',
      tenantId: 'tenant-4',
      data: {},
    });

    const publishChannel = mockRedis.publish.mock.calls[0][0] as string;
    const xaddKey = mockRedis.xadd.mock.calls[0][0] as string;

    // pub/sub channel uses spatula:events: prefix
    expect(publishChannel).toMatch(/^spatula:events:/);
    // stream key uses jobs: prefix
    expect(xaddKey).toMatch(/^jobs:/);
    // they must be different
    expect(publishChannel).not.toBe(xaddKey);
  });
});

describe('NoopEventPublisher', () => {
  it('does not throw', async () => {
    const publisher = new NoopEventPublisher();
    await expect(publisher.publish()).resolves.toBeUndefined();
  });
});
