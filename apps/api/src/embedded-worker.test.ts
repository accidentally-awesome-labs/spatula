import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerHandle } from '@spatula/queue';

describe('startEmbeddedWorker()', () => {
  const originalEnv = process.env.SPATULA_EMBEDDED_WORKER;

  afterEach(() => {
    // Restore env
    if (originalEnv === undefined) {
      delete process.env.SPATULA_EMBEDDED_WORKER;
    } else {
      process.env.SPATULA_EMBEDDED_WORKER = originalEnv;
    }
    vi.clearAllMocks();
  });

  it('Test 1: returns null when SPATULA_EMBEDDED_WORKER is unset', async () => {
    delete process.env.SPATULA_EMBEDDED_WORKER;
    const { startEmbeddedWorker } = await import('./embedded-worker.js');
    const result = await startEmbeddedWorker();
    expect(result).toBeNull();
  });

  it('Test 1b: returns null when SPATULA_EMBEDDED_WORKER is not "1"', async () => {
    process.env.SPATULA_EMBEDDED_WORKER = '0';
    const { startEmbeddedWorker } = await import('./embedded-worker.js');
    const result = await startEmbeddedWorker();
    expect(result).toBeNull();
  });

  it('Test 2: calls the injected startWorker factory exactly once when SPATULA_EMBEDDED_WORKER=1', async () => {
    process.env.SPATULA_EMBEDDED_WORKER = '1';
    const { startEmbeddedWorker } = await import('./embedded-worker.js');

    const mockHandle: WorkerHandle = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const mockFactory = vi.fn().mockResolvedValue(mockHandle);

    const result = await startEmbeddedWorker(mockFactory);

    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(result).toBe(mockHandle);
  });

  it('Test 3: the returned handle shutdown() is invokable', async () => {
    process.env.SPATULA_EMBEDDED_WORKER = '1';
    const { startEmbeddedWorker } = await import('./embedded-worker.js');

    const mockHandle: WorkerHandle = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const mockFactory = vi.fn().mockResolvedValue(mockHandle);

    const handle = await startEmbeddedWorker(mockFactory);
    expect(handle).not.toBeNull();

    // Invoke shutdown and verify it completes
    await handle!.shutdown();
    expect(mockHandle.shutdown).toHaveBeenCalledTimes(1);
  });
});
