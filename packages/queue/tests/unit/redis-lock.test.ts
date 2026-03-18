import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireLock, releaseLock } from '../../src/redis-lock.js';

function createMockRedis() {
  return {
    set: vi.fn(),
    call: vi.fn(),
  };
}

describe('Redis Distributed Lock', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  describe('acquireLock', () => {
    it('returns acquired=true and a token when SET NX succeeds', async () => {
      redis.set.mockResolvedValue('OK');

      const result = await acquireLock(redis as any, 'test-lock', 30);

      expect(result.acquired).toBe(true);
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
      expect(redis.set).toHaveBeenCalledWith(
        'test-lock',
        expect.any(String),
        'EX',
        30,
        'NX',
      );
    });

    it('returns acquired=false when SET NX fails (lock held)', async () => {
      redis.set.mockResolvedValue(null);

      const result = await acquireLock(redis as any, 'test-lock', 30);

      expect(result.acquired).toBe(false);
      expect(result.token).toBe('');
    });
  });

  describe('releaseLock', () => {
    it('calls Redis with Lua CAS script for safe release', async () => {
      redis.call.mockResolvedValue(1);

      await releaseLock(redis as any, 'test-lock', 'my-token');

      expect(redis.call).toHaveBeenCalledWith(
        'EVAL',
        expect.stringContaining('redis.call'),
        '1',
        'test-lock',
        'my-token',
      );
    });

    it('does not throw when key does not exist or token mismatches', async () => {
      redis.call.mockResolvedValue(0);

      await expect(
        releaseLock(redis as any, 'test-lock', 'wrong-token'),
      ).resolves.toBeUndefined();
    });
  });
});
