import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobProgressManager } from '../../../src/ws/job-progress.js';
import type { JobEvent } from '@spatula/queue';

function createMockRedis() {
  const handlers = new Map<string, (channel: string, message: string) => void>();
  return {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, handler);
    }),
    duplicate: vi.fn().mockReturnThis(),
    _handlers: handlers,
    _simulateMessage(channel: string, message: string) {
      const handler = handlers.get('message');
      if (handler) handler(channel, message);
    },
  };
}

function createMockWS() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  };
}

describe('JobProgressManager', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let manager: JobProgressManager;

  beforeEach(() => {
    mockRedis = createMockRedis();
    manager = new JobProgressManager(mockRedis as any);
  });

  it('subscribes to Redis channel on client connect', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    expect(mockRedis.subscribe).toHaveBeenCalledWith('spatula:events:job-1');
  });

  it('sends connected message on subscribe', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"connected"'));
  });

  it('forwards matching Redis events to WebSocket client', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    const event: JobEvent = {
      type: 'crawl_progress',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      timestamp: Date.now(),
      data: { pagesFound: 10 },
    };
    mockRedis._simulateMessage('spatula:events:job-1', JSON.stringify(event));

    expect(ws.send).toHaveBeenCalledTimes(2); // connected + forwarded
    const forwarded = JSON.parse(ws.send.mock.calls[1][0]);
    expect(forwarded.type).toBe('crawl_progress');
    expect(forwarded.data.pagesFound).toBe(10);
  });

  it('filters events by tenant to prevent cross-tenant leaks', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    const event: JobEvent = {
      type: 'crawl_progress',
      jobId: 'job-1',
      tenantId: 'tenant-OTHER',
      timestamp: Date.now(),
      data: { pagesFound: 10 },
    };
    mockRedis._simulateMessage('spatula:events:job-1', JSON.stringify(event));

    expect(ws.send).toHaveBeenCalledTimes(1); // only connected, event filtered
  });

  it('unsubscribes from Redis on client disconnect', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    await manager.removeClient('job-1', ws as any);
    expect(mockRedis.unsubscribe).toHaveBeenCalledWith('spatula:events:job-1');
  });

  it('does not unsubscribe if other clients remain on same job', async () => {
    const ws1 = createMockWS();
    const ws2 = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws1 as any);
    await manager.addClient('job-1', 'tenant-1', ws2 as any);
    await manager.removeClient('job-1', ws1 as any);
    expect(mockRedis.unsubscribe).not.toHaveBeenCalled();
  });

  it('skips send when WebSocket is not open', async () => {
    const ws = createMockWS();
    ws.readyState = 3; // CLOSED
    await manager.addClient('job-1', 'tenant-1', ws as any);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON messages from Redis', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    mockRedis._simulateMessage('spatula:events:job-1', 'not valid json {{{');
    expect(ws.send).toHaveBeenCalledTimes(1); // only connected
  });

  it('sends ping heartbeats at 30s intervals', async () => {
    vi.useFakeTimers();
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    expect(ws.send).toHaveBeenCalledTimes(1); // connected

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(2);
    const ping = JSON.parse(ws.send.mock.calls[1][0]);
    expect(ping.type).toBe('ping');

    vi.useRealTimers();
  });

  it('stops heartbeat when all clients disconnect', async () => {
    vi.useFakeTimers();
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    await manager.removeClient('job-1', ws as any);

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(1); // only connected

    vi.useRealTimers();
  });
});
