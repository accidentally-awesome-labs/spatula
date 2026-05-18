import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeShutdown } from '../../src/shutdown.js';
import type { AppDeps } from '../../src/types.js';
import type { JobProgressManager } from '../../src/ws/job-progress.js';
import type { ServerType } from '@hono/node-server';

vi.mock('@spatula/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@spatula/shared')>();
  return {
    ...actual,
    shutdownTracing: vi.fn().mockResolvedValue(undefined),
    shutdownMetrics: vi.fn().mockResolvedValue(undefined),
  };
});

function createMockServer(): ServerType {
  return {
    close: vi.fn((cb: () => void) => cb()),
  } as unknown as ServerType;
}

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn().mockResolvedValue(undefined) },
    redisSubscriber: { quit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as AppDeps;
}

function createMockProgressManager(): JobProgressManager {
  return { closeAll: vi.fn() } as unknown as JobProgressManager;
}

describe('executeShutdown', () => {
  let server: ServerType;
  let deps: AppDeps;

  beforeEach(() => {
    server = createMockServer();
    deps = createMockDeps();
  });

  it('calls server.close() and waits for callback', async () => {
    await executeShutdown(server, deps);
    expect((server as any).close).toHaveBeenCalledTimes(1);
  });

  it('calls progressManager.closeAll() when provided', async () => {
    const pm = createMockProgressManager();
    await executeShutdown(server, deps, pm);
    expect(pm.closeAll).toHaveBeenCalledTimes(1);
  });

  it('does NOT call closeAll when progressManager is undefined', async () => {
    // No progressManager passed — should not throw
    await expect(executeShutdown(server, deps)).resolves.toBeUndefined();
  });

  it('calls deps.redisSubscriber.quit() when available', async () => {
    await executeShutdown(server, deps);
    expect(deps.redisSubscriber!.quit).toHaveBeenCalledTimes(1);
  });

  it('does NOT call quit when redisSubscriber is undefined', async () => {
    const depsNoRedis = createMockDeps({ redisSubscriber: undefined });
    await expect(executeShutdown(server, depsNoRedis)).resolves.toBeUndefined();
  });

  it('calls deps.dbPool.end() when available', async () => {
    await executeShutdown(server, deps);
    expect(deps.dbPool.end).toHaveBeenCalledTimes(1);
  });

  it('does NOT call end when dbPool is undefined', async () => {
    const depsNoPool = createMockDeps();
    // Set dbPool to undefined (cast to bypass type)
    (depsNoPool as any).dbPool = undefined;
    await expect(executeShutdown(server, depsNoPool)).resolves.toBeUndefined();
  });

  it('closes resources in correct order: server -> WS -> Redis -> pool', async () => {
    const callOrder: string[] = [];

    const orderedServer = {
      close: vi.fn((cb: () => void) => {
        callOrder.push('server.close');
        cb();
      }),
    } as unknown as ServerType;

    const orderedPm = {
      closeAll: vi.fn(() => {
        callOrder.push('progressManager.closeAll');
      }),
    } as unknown as JobProgressManager;

    const orderedDeps = createMockDeps({
      redisSubscriber: {
        quit: vi.fn(async () => {
          callOrder.push('redis.quit');
        }),
      } as any,
      dbPool: {
        end: vi.fn(async () => {
          callOrder.push('dbPool.end');
        }),
      } as any,
    });

    await executeShutdown(orderedServer, orderedDeps, orderedPm);

    expect(callOrder).toEqual([
      'server.close',
      'progressManager.closeAll',
      'redis.quit',
      'dbPool.end',
    ]);
  });

  it('propagates errors if a step throws', async () => {
    const failingDeps = createMockDeps({
      redisSubscriber: {
        quit: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
      } as any,
    });

    await expect(executeShutdown(server, failingDeps)).rejects.toThrow('Redis connection lost');
  });
});
