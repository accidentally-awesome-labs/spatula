import type Redis from 'ioredis';
import { createLogger } from '@spatula/shared';

const logger = createLogger('redis-cache');
const KEY_PREFIX = 'cache:';

export class RedisCache {
  constructor(private readonly redis: Redis) {}

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const cacheKey = `${KEY_PREFIX}${key}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch (err) {
      logger.warn({ err, key }, 'Cache read failed, falling through to fetcher');
    }

    const value = await fetcher();

    try {
      await this.redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'Cache write failed');
    }

    return value;
  }

  async delete(key: string): Promise<void> {
    const cacheKey = `${KEY_PREFIX}${key}`;
    try {
      await this.redis.del(cacheKey);
    } catch (err) {
      logger.warn({ err, key }, 'Cache delete failed');
    }
  }

  async invalidate(pattern: string): Promise<void> {
    const cachePattern = `${KEY_PREFIX}${pattern}`;
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', cachePattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.warn({ err, pattern }, 'Cache invalidation failed');
    }
  }
}
