import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Domain rate limiter strategy interface.
 * Server mode: implement with Redis SETEX for cross-worker coordination.
 * Local mode: use InMemoryDomainRateLimiter below.
 */
export interface DomainRateLimiter {
  waitForSlot(url: string, crawlDelay?: number): Promise<void>;
}

/**
 * In-memory per-domain rate limiter for single-process local mode.
 * For server mode with multiple workers, implement DomainRateLimiter with Redis.
 *
 * Uses a per-domain promise chain to serialize concurrent calls and prevent
 * two concurrent requests from firing simultaneously (race condition fix).
 */
export class InMemoryDomainRateLimiter implements DomainRateLimiter {
  private lastRequestTime = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private defaultDelayMs: number;

  constructor(defaultDelayMs = 1000) {
    this.defaultDelayMs = defaultDelayMs;
  }

  /**
   * Wait until it's safe to make a request to the given URL's domain.
   *
   * @param url The URL to crawl
   * @param crawlDelay Optional Crawl-Delay from robots.txt (in seconds)
   */
  async waitForSlot(url: string, crawlDelay?: number): Promise<void> {
    const hostname = new URL(url).hostname;
    const delayMs = crawlDelay != null ? crawlDelay * 1000 : this.defaultDelayMs;

    const prev = this.pending.get(hostname) ?? Promise.resolve();
    const next = prev.then(async () => {
      const lastTime = this.lastRequestTime.get(hostname);
      if (lastTime != null) {
        const elapsed = Date.now() - lastTime;
        if (elapsed < delayMs) {
          await sleep(delayMs - elapsed);
        }
      }
      this.lastRequestTime.set(hostname, Date.now());
    });
    this.pending.set(hostname, next);
    await next;
  }
}
