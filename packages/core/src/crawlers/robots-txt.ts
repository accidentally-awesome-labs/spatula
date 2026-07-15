import robotsParser from 'robots-parser';
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';

const logger = createLogger('robots-txt');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 1000;

interface CacheEntry {
  robotsTxt: ReturnType<typeof robotsParser>;
  fetchedAt: number;
}

/**
 * Fetches and caches robots.txt per domain.
 * Checks if a URL is allowed for crawling by the SpatulaBot user agent.
 *
 * Fails open: if robots.txt can't be fetched (network error, 5xx),
 * the URL is allowed. Only explicit Disallow rules block crawling.
 *
 * Cache is bounded to MAX_CACHE_SIZE entries with LRU eviction.
 */
export class RobotsTxtChecker {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<CacheEntry | null>>();
  private userAgent: string;

  constructor(userAgent = 'SpatulaBot/1.0') {
    this.userAgent = userAgent;
  }

  async isAllowed(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    const entry = await this.getOrFetch(origin);
    if (!entry) return true; // fail open

    return entry.robotsTxt.isAllowed(url, this.userAgent) ?? true;
  }

  getCrawlDelay(origin: string, userAgent?: string): number | null {
    const normalizedOrigin = origin.startsWith('http') ? new URL(origin).origin : origin;
    const entry = this.cache.get(normalizedOrigin);
    if (!entry) return null;

    const ua = userAgent ?? this.userAgent;
    const delay = entry.robotsTxt.getCrawlDelay(ua);
    return delay !== undefined ? delay : null;
  }

  private async getOrFetch(origin: string): Promise<CacheEntry | null> {
    const existing = this.cache.get(origin);
    if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
      // LRU touch: delete + re-insert to move to end of Map
      this.cache.delete(origin);
      this.cache.set(origin, existing);
      return existing;
    }

    // Deduplicate concurrent fetches for the same domain
    const pending = this.inFlight.get(origin);
    if (pending) return pending;

    const promise = this.doFetch(origin);
    this.inFlight.set(origin, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(origin);
    }
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_CACHE_SIZE) return;
    // Evict oldest entries (Map preserves insertion order)
    const toEvict = this.cache.size - MAX_CACHE_SIZE;
    let evicted = 0;
    for (const key of this.cache.keys()) {
      if (evicted >= toEvict) break;
      this.cache.delete(key);
      evicted++;
    }
  }

  private async doFetch(origin: string): Promise<CacheEntry | null> {
    try {
      const response = await fetch(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // No robots.txt or error — allow everything
        const entry: CacheEntry = {
          robotsTxt: robotsParser(`${origin}/robots.txt`, ''),
          fetchedAt: Date.now(),
        };
        this.cache.set(origin, entry);
        this.evictIfNeeded();
        return entry;
      }

      const text = await response.text();
      const entry: CacheEntry = {
        robotsTxt: robotsParser(`${origin}/robots.txt`, text),
        fetchedAt: Date.now(),
      };
      this.cache.set(origin, entry);
      this.evictIfNeeded();
      return entry;
    } catch (err) {
      logger.warn(
        { origin, error: (err as Error).message },
        'Failed to fetch robots.txt, allowing crawl',
      );
      return null;
    }
  }
}
