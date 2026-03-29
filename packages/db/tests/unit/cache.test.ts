import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCache } from '../../src/cache.js';

function createMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    scan: vi.fn(),
    del: vi.fn(),
  };
}

describe('RedisCache', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: RedisCache;

  beforeEach(() => {
    redis = createMockRedis();
    cache = new RedisCache(redis as any);
  });

  describe('getOrFetch', () => {
    it('returns cached value on hit', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ version: 1 }));
      const result = await cache.getOrFetch('schema:job-1:current', async () => {
        throw new Error('should not be called');
      }, 30);
      expect(result).toEqual({ version: 1 });
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('calls fetcher on miss and caches result', async () => {
      redis.get.mockResolvedValue(null);
      redis.set.mockResolvedValue('OK');
      const fetcher = vi.fn().mockResolvedValue({ version: 2 });
      const result = await cache.getOrFetch('schema:job-1:current', fetcher, 30);
      expect(result).toEqual({ version: 2 });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(redis.set).toHaveBeenCalledWith('cache:schema:job-1:current', JSON.stringify({ version: 2 }), 'EX', 30);
    });

    it('returns fetcher result when Redis is unavailable', async () => {
      redis.get.mockRejectedValue(new Error('connection refused'));
      const fetcher = vi.fn().mockResolvedValue({ fallback: true });
      const result = await cache.getOrFetch('key', fetcher, 30);
      expect(result).toEqual({ fallback: true });
    });
  });

  describe('delete', () => {
    it('deletes a single exact key', async () => {
      redis.del.mockResolvedValue(1);
      await cache.delete('entity-count:job-1');
      expect(redis.del).toHaveBeenCalledWith('cache:entity-count:job-1');
      expect(redis.scan).not.toHaveBeenCalled();
    });

    it('handles Redis errors gracefully', async () => {
      redis.del.mockRejectedValue(new Error('connection refused'));
      await expect(cache.delete('some-key')).resolves.not.toThrow();
    });
  });

  describe('invalidate', () => {
    it('deletes keys matching pattern using SCAN', async () => {
      redis.scan.mockResolvedValueOnce(['10', ['cache:schema:job-1:current', 'cache:schema:job-1:v2']]).mockResolvedValueOnce(['0', []]);
      redis.del.mockResolvedValue(2);
      await cache.invalidate('schema:job-1:*');
      expect(redis.del).toHaveBeenCalledWith('cache:schema:job-1:current', 'cache:schema:job-1:v2');
    });

    it('handles no matching keys gracefully', async () => {
      redis.scan.mockResolvedValue(['0', []]);
      await expect(cache.invalidate('nonexistent:*')).resolves.not.toThrow();
    });
  });
});
