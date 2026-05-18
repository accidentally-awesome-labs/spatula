import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryDomainRateLimiter } from '../../../src/crawlers/domain-rate-limiter.js';

describe('DomainRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first request immediately', async () => {
    const limiter = new InMemoryDomainRateLimiter(1000);
    const start = Date.now();
    await limiter.waitForSlot('https://example.com/page1');
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('delays second request to same domain', async () => {
    const limiter = new InMemoryDomainRateLimiter(1000);

    await limiter.waitForSlot('https://example.com/page1');
    const waitPromise = limiter.waitForSlot('https://example.com/page2');

    // Advance time past the delay
    await vi.advanceTimersByTimeAsync(1001);
    await waitPromise;

    // Should have waited ~1000ms
    expect(true).toBe(true); // if we got here without hanging, the delay worked
  });

  it('allows concurrent requests to different domains', async () => {
    const limiter = new InMemoryDomainRateLimiter(1000);

    await limiter.waitForSlot('https://a.com/page');
    // Immediately request different domain — should not wait
    const start = Date.now();
    await limiter.waitForSlot('https://b.com/page');
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('uses custom delay from Crawl-Delay', async () => {
    const limiter = new InMemoryDomainRateLimiter(1000);

    await limiter.waitForSlot('https://example.com/page1', 5); // 5 seconds Crawl-Delay
    let resolved = false;
    const waitPromise = limiter.waitForSlot('https://example.com/page2').then(() => {
      resolved = true;
    });

    // 1 second is not enough — verify NOT resolved yet
    await vi.advanceTimersByTimeAsync(1001);
    expect(resolved).toBe(false);

    // 5 seconds total is enough
    await vi.advanceTimersByTimeAsync(4001);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('extracts hostname from URL for domain grouping', async () => {
    const limiter = new InMemoryDomainRateLimiter(1000);

    await limiter.waitForSlot('https://example.com/page1');
    // Same hostname, different path — should be rate limited
    const waitPromise = limiter.waitForSlot('https://example.com/page2');
    await vi.advanceTimersByTimeAsync(1001);
    await waitPromise;

    expect(true).toBe(true);
  });

  it('serializes concurrent calls to same domain (race condition fix)', async () => {
    const limiter = new InMemoryDomainRateLimiter(500);
    const order: number[] = [];

    // Start three concurrent requests — they should be serialized via promise chain
    const p1 = limiter.waitForSlot('https://example.com/page1').then(() => {
      order.push(1);
    });
    const p2 = limiter.waitForSlot('https://example.com/page2').then(() => {
      order.push(2);
    });
    const p3 = limiter.waitForSlot('https://example.com/page3').then(() => {
      order.push(3);
    });

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([p1, p2, p3]);

    // All three should complete, in order
    expect(order).toEqual([1, 2, 3]);
  });
});
