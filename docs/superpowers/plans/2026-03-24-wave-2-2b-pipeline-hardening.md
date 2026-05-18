# Wave 2.2b: Pipeline Hardening — robots.txt, Politeness, maxPages, Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ethical crawling controls (robots.txt compliance, per-domain rate limiting), enforce the maxPages budget, and detect crawl completion — all as reusable utilities in `@spatula/core` that both server workers and the future local pipeline can use.

**Architecture:** Four utilities behind strategy interfaces in `@spatula/core/crawlers/`: (1) `RobotsTxtChecker` fetches and caches robots.txt per domain with 1-hour TTL, (2) `DomainRateLimiter` interface with in-memory implementation (local mode) — Redis-backed implementation deferred to when Redis infrastructure features are built, (3) `PageBudget` interface with in-memory implementation (local mode) — Redis-backed implementation deferred similarly, (4) `CrawlCompletionChecker` queries task status to detect natural completion. A new Task 6 wires all four utilities into the crawl worker. The `CrawlOptions` schema gets a `respectRobotsTxt` field.

**Note on Redis implementations:** The spec calls for Redis-backed rate limiter and page counter for multi-worker correctness. This plan provides the interfaces + in-memory implementations. Redis implementations will be added when `@spatula/queue` worker DI is fully wired (Wave 2 completion). The interfaces ensure the swap is seamless.

**Tech Stack:** TypeScript, Vitest, `robots-parser` (robots.txt parsing), `node:timers/promises` (sleep)

**Spec references:**

- Phase 12 spec: sections 7.1 (robots.txt), 7.2 (maxPages), 7.3 (politeness), 7.4 (completion)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File                                                            | Responsibility                            |
| --------------------------------------------------------------- | ----------------------------------------- |
| `packages/core/src/crawlers/robots-txt.ts`                      | Fetch, parse, cache robots.txt per domain |
| `packages/core/src/crawlers/domain-rate-limiter.ts`             | In-memory per-domain request delay        |
| `packages/core/src/crawlers/page-budget.ts`                     | maxPages tracking with atomic increment   |
| `packages/core/src/crawlers/completion-checker.ts`              | Detect when all crawl tasks are done      |
| `packages/core/tests/unit/crawlers/robots-txt.test.ts`          | robots.txt tests                          |
| `packages/core/tests/unit/crawlers/domain-rate-limiter.test.ts` | Rate limiter tests                        |
| `packages/core/tests/unit/crawlers/page-budget.test.ts`         | Page budget tests                         |
| `packages/core/tests/unit/crawlers/completion-checker.test.ts`  | Completion detection tests                |

### Modified Files

| File                                      | Change                                 |
| ----------------------------------------- | -------------------------------------- |
| `packages/core/src/interfaces/crawler.ts` | Add `respectRobotsTxt` to CrawlOptions |
| `packages/core/src/crawlers/index.ts`     | Export new modules                     |
| `packages/core/package.json`              | Add `robots-parser` dependency         |

---

## Task 1: robots.txt Checker

**Files:**

- Create: `packages/core/src/crawlers/robots-txt.ts`
- Create: `packages/core/tests/unit/crawlers/robots-txt.test.ts`
- Modify: `packages/core/src/interfaces/crawler.ts` (add respectRobotsTxt)
- Modify: `packages/core/package.json` (add robots-parser)

- [ ] **Step 1: Install robots-parser**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core add robots-parser`

- [ ] **Step 2: Add respectRobotsTxt to CrawlOptions**

In `packages/core/src/interfaces/crawler.ts`, add to the CrawlOptions schema:

```typescript
  respectRobotsTxt: z.boolean().default(true),
```

This is backward-compatible (defaults to true).

- [ ] **Step 3: Write failing tests**

```typescript
// packages/core/tests/unit/crawlers/robots-txt.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RobotsTxtChecker } from '../../../src/crawlers/robots-txt.js';

describe('RobotsTxtChecker', () => {
  let checker: RobotsTxtChecker;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    checker = new RobotsTxtChecker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows URL when no robots.txt exists (404)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const allowed = await checker.isAllowed('https://example.com/page');
    expect(allowed).toBe(true);
  });

  it('blocks URL disallowed by robots.txt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow: /private/'),
    });
    const allowed = await checker.isAllowed('https://example.com/private/secret');
    expect(allowed).toBe(false);
  });

  it('allows URL not disallowed by robots.txt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow: /private/'),
    });
    const allowed = await checker.isAllowed('https://example.com/public/page');
    expect(allowed).toBe(true);
  });

  it('caches robots.txt per domain (does not refetch)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page1');
    await checker.isAllowed('https://example.com/page2');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different domains', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://a.com/page');
    await checker.isAllowed('https://b.com/page');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses SpatulaBot as default user agent', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve('User-agent: SpatulaBot\nDisallow: /blocked/\n\nUser-agent: *\nDisallow:'),
    });
    const allowed = await checker.isAllowed('https://example.com/blocked/page');
    expect(allowed).toBe(false);
  });

  it('returns Crawl-Delay if specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nCrawl-delay: 5\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page');
    const delay = checker.getCrawlDelay('https://example.com');
    expect(delay).toBe(5);
  });

  it('returns null for Crawl-Delay when not specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page');
    const delay = checker.getCrawlDelay('https://example.com');
    expect(delay).toBeNull();
  });

  it('refetches robots.txt after 1-hour TTL expires', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past 1-hour TTL
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    await checker.isAllowed('https://example.com/page2');
    expect(mockFetch).toHaveBeenCalledTimes(2); // refetched
    vi.useRealTimers();
  });

  it('handles fetch errors gracefully (allows crawl)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const allowed = await checker.isAllowed('https://example.com/page');
    expect(allowed).toBe(true); // fail open — don't block on robots.txt errors
  });
});
```

- [ ] **Step 4: Implement RobotsTxtChecker**

```typescript
// packages/core/src/crawlers/robots-txt.ts
import robotsParser from 'robots-parser';
import { createLogger } from '@spatula/shared';

const logger = createLogger('robots-txt');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
 */
export class RobotsTxtChecker {
  private cache = new Map<string, CacheEntry>();
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
      return existing;
    }

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
        return entry;
      }

      const text = await response.text();
      const entry: CacheEntry = {
        robotsTxt: robotsParser(`${origin}/robots.txt`, text),
        fetchedAt: Date.now(),
      };
      this.cache.set(origin, entry);
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
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run robots-txt`

- [ ] **Step 6: Update crawlers barrel export**

Add to `packages/core/src/crawlers/index.ts`:

```typescript
export { RobotsTxtChecker } from './robots-txt.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/crawlers/robots-txt.ts packages/core/tests/unit/crawlers/robots-txt.test.ts packages/core/src/interfaces/crawler.ts packages/core/src/crawlers/index.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add robots.txt compliance checker with per-domain caching"
```

---

## Task 2: Domain Rate Limiter

**Files:**

- Create: `packages/core/src/crawlers/domain-rate-limiter.ts`
- Create: `packages/core/tests/unit/crawlers/domain-rate-limiter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/crawlers/domain-rate-limiter.test.ts
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
});
```

- [ ] **Step 2: Implement DomainRateLimiter**

```typescript
// packages/core/src/crawlers/domain-rate-limiter.ts
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
 */
export class InMemoryDomainRateLimiter implements DomainRateLimiter {
  private lastRequestTime = new Map<string, number>();
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

    const lastTime = this.lastRequestTime.get(hostname);
    if (lastTime != null) {
      const elapsed = Date.now() - lastTime;
      if (elapsed < delayMs) {
        await sleep(delayMs - elapsed);
      }
    }

    this.lastRequestTime.set(hostname, Date.now());
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run domain-rate-limiter`

- [ ] **Step 4: Export and commit**

Add to `packages/core/src/crawlers/index.ts`:

```typescript
export { InMemoryDomainRateLimiter } from './domain-rate-limiter.js';
export type { DomainRateLimiter } from './domain-rate-limiter.js';
```

```bash
git add packages/core/src/crawlers/domain-rate-limiter.ts packages/core/tests/unit/crawlers/domain-rate-limiter.test.ts packages/core/src/crawlers/index.ts
git commit -m "feat(core): add per-domain rate limiter for crawl politeness"
```

---

## Task 3: Page Budget Counter

**Files:**

- Create: `packages/core/src/crawlers/page-budget.ts`
- Create: `packages/core/tests/unit/crawlers/page-budget.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/crawlers/page-budget.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryPageBudget } from '../../../src/crawlers/page-budget.js';

describe('InMemoryPageBudget', () => {
  it('allows pages within budget', () => {
    const counter = new InMemoryPageBudget(5);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.count).toBe(2);
  });

  it('rejects pages exceeding budget', () => {
    const counter = new InMemoryPageBudget(3);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(false); // 4th page rejected
    expect(counter.count).toBe(3);
  });

  it('reports remaining budget', () => {
    const counter = new InMemoryPageBudget(10);
    counter.tryIncrement();
    counter.tryIncrement();
    expect(counter.remaining).toBe(8);
  });

  it('reports whether budget is exhausted', () => {
    const counter = new InMemoryPageBudget(2);
    expect(counter.isExhausted).toBe(false);
    counter.tryIncrement();
    counter.tryIncrement();
    expect(counter.isExhausted).toBe(true);
  });

  it('handles maxPages of 1', () => {
    const counter = new InMemoryPageBudget(1);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(false);
  });

  it('returns current count and max', () => {
    const counter = new InMemoryPageBudget(100);
    expect(counter.count).toBe(0);
    expect(counter.maxPages).toBe(100);
  });
});
```

- [ ] **Step 2: Implement InMemoryPageBudget**

```typescript
// packages/core/src/crawlers/page-budget.ts

/**
 * Page budget strategy interface.
 * Server mode: implement with Redis INCR for multi-worker atomicity.
 * Local mode: use InMemoryPageBudget below.
 */
export interface PageBudget {
  tryIncrement(): Promise<boolean> | boolean;
  get count(): number;
  get remaining(): number;
  get isExhausted(): boolean;
  get maxPages(): number;
}

/**
 * In-memory page budget counter for single-process local mode.
 * For server mode with multiple workers, implement PageBudget with Redis INCR.
 */
export class InMemoryPageBudget implements PageBudget {
  private _count = 0;
  readonly maxPages: number;

  constructor(maxPages: number) {
    this.maxPages = maxPages;
  }

  /**
   * Try to increment the page count.
   * Returns true if within budget (page allowed), false if budget exhausted.
   */
  tryIncrement(): boolean {
    if (this._count >= this.maxPages) return false;
    this._count++;
    return true;
  }

  get count(): number {
    return this._count;
  }

  get remaining(): number {
    return Math.max(0, this.maxPages - this._count);
  }

  get isExhausted(): boolean {
    return this._count >= this.maxPages;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run page-budget`

- [ ] **Step 4: Export and commit**

Add to `packages/core/src/crawlers/index.ts`:

```typescript
export { InMemoryPageBudget } from './page-budget.js';
export type { PageBudget } from './page-budget.js';
```

```bash
git add packages/core/src/crawlers/page-budget.ts packages/core/tests/unit/crawlers/page-budget.test.ts packages/core/src/crawlers/index.ts
git commit -m "feat(core): add page budget counter for maxPages enforcement"
```

---

## Task 4: Crawl Completion Checker

**Files:**

- Create: `packages/core/src/crawlers/completion-checker.ts`
- Create: `packages/core/tests/unit/crawlers/completion-checker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/crawlers/completion-checker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CrawlCompletionChecker } from '../../../src/crawlers/completion-checker.js';

function createMockTaskRepo(stats: {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}) {
  return {
    getJobStats: vi.fn().mockResolvedValue(stats),
  };
}

describe('CrawlCompletionChecker', () => {
  it('returns complete when no pending or in-progress tasks', async () => {
    const repo = createMockTaskRepo({
      pending: 0,
      inProgress: 0,
      completed: 50,
      failed: 2,
      skipped: 3,
    });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('all_tasks_done');
  });

  it('returns incomplete when tasks are pending', async () => {
    const repo = createMockTaskRepo({
      pending: 5,
      inProgress: 2,
      completed: 50,
      failed: 0,
      skipped: 0,
    });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(false);
  });

  it('returns incomplete when tasks are in progress', async () => {
    const repo = createMockTaskRepo({
      pending: 0,
      inProgress: 3,
      completed: 50,
      failed: 0,
      skipped: 0,
    });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(false);
  });

  it('accounts for the current task (inProgress <= 1 with pending 0)', async () => {
    // The current task is still "in_progress" when this check runs
    const repo = createMockTaskRepo({
      pending: 0,
      inProgress: 1,
      completed: 49,
      failed: 0,
      skipped: 0,
    });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('all_tasks_done');
  });

  it('returns stats in the result', async () => {
    const stats = { pending: 0, inProgress: 0, completed: 100, failed: 5, skipped: 10 };
    const repo = createMockTaskRepo(stats);
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.stats).toEqual(stats);
  });
});
```

- [ ] **Step 2: Implement CrawlCompletionChecker**

```typescript
// packages/core/src/crawlers/completion-checker.ts
import { createLogger } from '@spatula/shared';

const logger = createLogger('completion-checker');

export interface TaskStats {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface CompletionResult {
  complete: boolean;
  reason?: 'all_tasks_done' | 'budget_exhausted';
  stats: TaskStats;
}

export interface TaskStatsRepo {
  getJobStats(jobId: string, tenantId: string): Promise<TaskStats>;
}

/**
 * Detects when a crawl job has naturally completed.
 *
 * A job is complete when:
 * - No pending crawl tasks remain
 * - At most 1 in-progress task (the current one calling this check)
 * - All tasks are completed, failed, or skipped
 */
export class CrawlCompletionChecker {
  async isComplete(
    jobId: string,
    tenantId: string,
    taskRepo: TaskStatsRepo,
  ): Promise<CompletionResult> {
    const stats = await taskRepo.getJobStats(jobId, tenantId);

    // No pending tasks, and at most 1 in-progress (the current task)
    const complete = stats.pending === 0 && stats.inProgress <= 1;

    if (complete) {
      logger.info({ jobId, ...stats }, 'Crawl naturally complete — all tasks processed');
    }

    return {
      complete,
      reason: complete ? 'all_tasks_done' : undefined,
      stats,
    };
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run completion-checker`

- [ ] **Step 4: Export and commit**

Add to `packages/core/src/crawlers/index.ts`:

```typescript
export { CrawlCompletionChecker } from './completion-checker.js';
export type { TaskStats, CompletionResult, TaskStatsRepo } from './completion-checker.js';
```

```bash
git add packages/core/src/crawlers/completion-checker.ts packages/core/tests/unit/crawlers/completion-checker.test.ts packages/core/src/crawlers/index.ts
git commit -m "feat(core): add crawl completion detection heuristic"
```

---

## Task 5: Wire Utilities into Crawl Worker

**Files:**

- Modify: `packages/queue/src/worker-deps.ts` (add new deps)
- Modify: `packages/queue/src/workers/crawl-worker.ts` (integrate all 4 utilities)

- [ ] **Step 1: Add pipeline hardening deps to WorkerDeps**

Read `packages/queue/src/worker-deps.ts` first. Add optional fields for the 4 utilities:

```typescript
import type { RobotsTxtChecker, DomainRateLimiter, PageBudget, CrawlCompletionChecker } from '@spatula/core';

// Add to WorkerDepsConfig interface and WorkerDeps class:
robotsChecker?: RobotsTxtChecker;
rateLimiter?: DomainRateLimiter;
pageBudget?: PageBudget;
completionChecker?: CrawlCompletionChecker;
```

These are optional so existing code (tests, worker-entrypoint) continues to work without providing them.

**Note on `respectRobotsTxt` config:** The worker checks `if (deps.robotsChecker)` — this is sufficient because the DI wiring layer (not yet built) is responsible for conditionally providing the checker based on the job's `respectRobotsTxt` config. When `respectRobotsTxt: false`, the wiring layer simply doesn't inject the checker.

- [ ] **Step 2: Check if `CrawlTaskRepository` has `getJobStats()`**

Read `packages/db/src/repositories/crawl-task-repository.ts` and check if it has a `getJobStats()` method that returns counts by status. If not, add one:

```typescript
async getJobStats(jobId: string, tenantId: string): Promise<{
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}> {
  // Query crawl_tasks grouped by status for this job
  const rows = await this.db.select({
    status: crawlTasks.status,
    count: sql<number>`count(*)`,
  })
  .from(crawlTasks)
  .where(and(eq(crawlTasks.jobId, jobId), eq(crawlTasks.tenantId, tenantId)))
  .groupBy(crawlTasks.status);

  const stats = { pending: 0, inProgress: 0, completed: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const key = row.status === 'in_progress' ? 'inProgress' : row.status;
    if (key in stats) stats[key as keyof typeof stats] = row.count;
  }
  return stats;
}
```

If the method already exists, skip this step.

- [ ] **Step 3: Integrate into crawl-worker.ts**

Read the current `packages/queue/src/workers/crawl-worker.ts`. Add checks BEFORE the `processCrawlTask` call and completion check AFTER:

```typescript
// BEFORE delegating to orchestrator:

// 1. Check page budget
if (deps.pageBudget) {
  const allowed = await Promise.resolve(deps.pageBudget.tryIncrement());
  if (!allowed) {
    logger.info({ taskId, url }, 'Page budget exhausted, skipping');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
    return;
  }
}

// 2. Check robots.txt
if (deps.robotsChecker) {
  const robotsAllowed = await deps.robotsChecker.isAllowed(url);
  if (!robotsAllowed) {
    logger.info({ taskId, url }, 'Blocked by robots.txt, skipping');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
    return;
  }
}

// 3. Wait for domain rate limit slot
if (deps.rateLimiter) {
  const crawlDelay = deps.robotsChecker?.getCrawlDelay(url) ?? undefined;
  await deps.rateLimiter.waitForSlot(url, crawlDelay);
}

// 4. Delegate to orchestrator (existing processCrawlTask call)
const result = await processCrawlTask(...);

// ... existing schema evolution + link enqueue code (unchanged) ...

// AFTER all processing:

// 5. Check crawl completion
if (deps.completionChecker && !result.error) {
  const completion = await deps.completionChecker.isComplete(
    jobId, tenantId, deps.taskRepo as any,
  );
  if (completion.complete) {
    logger.info({ jobId, ...completion.stats }, 'Crawl naturally complete, triggering reconciliation');
    // Enqueue reconciliation job directly (worker has queues, not jobManager)
    await deps.queues.reconciliation.add(
      `reconciliation:${jobId}`,
      { jobId, tenantId },
    );
  }
}
```

**Key difference from earlier plan:** Completion triggers reconciliation via `deps.queues.reconciliation.add()` — NOT `deps.jobManager.triggerReconciliation()`. The worker has `deps.queues` but NOT `jobManager`. This avoids adding `jobManager` to `WorkerDeps`.

**Note on `pageBudget.tryIncrement()`:** The interface returns `Promise<boolean> | boolean` (sync for in-memory, async for future Redis). Wrapping with `Promise.resolve()` handles both.

- [ ] **Step 4: Fix existing test mocks**

Update worker test mocks to include the new optional deps (set to `undefined` for existing tests):

```typescript
// In test mock factory, add:
robotsChecker: undefined,
rateLimiter: undefined,
pageBudget: undefined,
completionChecker: undefined,
```

- [ ] **Step 5: Write NEW integration tests**

Add new test cases to `packages/queue/tests/unit/workers/crawl-worker.test.ts`:

```typescript
describe('pipeline hardening integration', () => {
  it('skips task when page budget is exhausted', async () => {
    const deps = createMockDeps();
    deps.pageBudget = {
      tryIncrement: () => false,
      count: 100,
      remaining: 0,
      isExhausted: true,
      maxPages: 100,
    };

    await processCrawlJob(data, deps);

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith(taskId, tenantId, 'skipped');
    expect(deps.crawler.crawl).not.toHaveBeenCalled(); // didn't even crawl
  });

  it('skips task when blocked by robots.txt', async () => {
    const deps = createMockDeps();
    deps.robotsChecker = { isAllowed: vi.fn().mockResolvedValue(false), getCrawlDelay: vi.fn() };

    await processCrawlJob(data, deps);

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith(taskId, tenantId, 'skipped');
    expect(deps.crawler.crawl).not.toHaveBeenCalled();
  });

  it('waits for rate limiter before crawling', async () => {
    const deps = createMockDeps();
    const waitForSlot = vi.fn().mockResolvedValue(undefined);
    deps.rateLimiter = { waitForSlot };

    await processCrawlJob(data, deps);

    expect(waitForSlot).toHaveBeenCalledWith(data.url, undefined);
    expect(deps.crawler.crawl).toHaveBeenCalled(); // crawl happened after wait
  });

  it('enqueues reconciliation when crawl is naturally complete', async () => {
    const deps = createMockDeps();
    deps.completionChecker = {
      isComplete: vi.fn().mockResolvedValue({
        complete: true,
        reason: 'all_tasks_done',
        stats: { pending: 0, inProgress: 1, completed: 50, failed: 0, skipped: 0 },
      }),
    };

    await processCrawlJob(data, deps);

    expect(deps.queues.reconciliation.add).toHaveBeenCalledWith(
      expect.stringContaining('reconciliation:'),
      expect.objectContaining({ jobId: data.jobId, tenantId: data.tenantId }),
    );
  });

  it('does not enqueue reconciliation when crawl is not complete', async () => {
    const deps = createMockDeps();
    deps.completionChecker = {
      isComplete: vi.fn().mockResolvedValue({
        complete: false,
        stats: { pending: 5, inProgress: 2, completed: 40, failed: 0, skipped: 0 },
      }),
    };

    await processCrawlJob(data, deps);

    expect(deps.queues.reconciliation.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run worker tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run crawl-worker`

- [ ] **Step 7: Run full queue tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`

- [ ] **Step 8: Commit**

```bash
git add packages/queue/src/worker-deps.ts packages/queue/src/workers/crawl-worker.ts packages/queue/tests/ packages/db/src/repositories/crawl-task-repository.ts
git commit -m "feat(queue): wire robots.txt, rate limiter, page budget, completion into crawl worker"
```

---

## Task 6: Integration Verification

- [ ] **Step 1: Run full core test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`

- [ ] **Step 2: Run full queue test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`

- [ ] **Step 3: Run builds**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build && pnpm --filter @spatula/queue build`

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.2b — robots.txt, politeness, maxPages, completion"
```
