import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function acquireLock(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<{ acquired: boolean; token: string }> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');

  if (result === 'OK') {
    return { acquired: true, token };
  }

  return { acquired: false, token: '' };
}

export async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.call('EVAL', RELEASE_SCRIPT, '1', key, token);
}
