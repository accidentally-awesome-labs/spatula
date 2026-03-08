# Phase 2: Pluggable Crawler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement two crawler adapters (Playwright and Firecrawl) that satisfy the `Crawler` interface, with robust link extraction, error handling, and a comparison utility for benchmarking both crawlers against the same URL.

**Architecture:** Each crawler adapter is a standalone class in `packages/core/src/crawlers/` implementing the `Crawler` interface from Phase 1. A `CrawlerFactory` creates the right adapter based on config. A shared `LinkExtractor` utility parses raw HTML to discover links. A `CrawlerComparison` utility runs both adapters against the same URL and produces a structured diff. All external dependencies (Playwright, Firecrawl SDK) are injected or configurable, making the adapters testable with mocks.

**Tech Stack:** Playwright (`playwright`), Firecrawl SDK (`@mendable/firecrawl-js`), Cheerio (`cheerio` for HTML link parsing), Vitest for testing

**Depends on:** Phase 1 complete — `Crawler` interface, `CrawlResult`, `CrawlOptions` Zod schemas, `CrawlError` from shared, `createLogger`/`extractDomain`/`generateId` from shared

---

## Task 1: Install Phase 2 Dependencies

**Files:**
- Modify: `packages/core/package.json`

**Step 1: Install production dependencies**

Run:
```bash
cd packages/core && pnpm add playwright cheerio @mendable/firecrawl-js
```

**Step 2: Install dev dependencies (types)**

Run:
```bash
cd packages/core && pnpm add -D @types/cheerio
```

Note: `playwright` includes its own types. `@mendable/firecrawl-js` includes its own types.

**Step 3: Verify build still works**

Run: `pnpm build`
Expected: All packages compile

**Step 4: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add playwright, firecrawl, cheerio dependencies for Phase 2"
```

---

## Task 2: Link Extractor Utility

A shared utility that extracts and normalizes links from raw HTML. Both crawlers use this so link extraction logic is DRY.

**Files:**
- Create: `packages/core/src/crawlers/link-extractor.ts`
- Create: `packages/core/tests/unit/crawlers/link-extractor.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/crawlers/link-extractor.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { extractLinks, resolveUrl } from '../../../src/crawlers/link-extractor.js';

describe('resolveUrl', () => {
  it('resolves relative URLs against base', () => {
    expect(resolveUrl('/products/123', 'https://example.com/page')).toBe(
      'https://example.com/products/123',
    );
  });

  it('returns absolute URLs unchanged', () => {
    expect(resolveUrl('https://other.com/page', 'https://example.com')).toBe(
      'https://other.com/page',
    );
  });

  it('resolves protocol-relative URLs', () => {
    expect(resolveUrl('//cdn.example.com/img.png', 'https://example.com')).toBe(
      'https://cdn.example.com/img.png',
    );
  });

  it('returns null for invalid URLs', () => {
    expect(resolveUrl('javascript:void(0)', 'https://example.com')).toBeNull();
  });

  it('returns null for mailto links', () => {
    expect(resolveUrl('mailto:test@test.com', 'https://example.com')).toBeNull();
  });

  it('returns null for tel links', () => {
    expect(resolveUrl('tel:+1234567890', 'https://example.com')).toBeNull();
  });

  it('strips hash fragments', () => {
    expect(resolveUrl('/page#section', 'https://example.com')).toBe(
      'https://example.com/page',
    );
  });
});

describe('extractLinks', () => {
  it('extracts links from anchor tags', () => {
    const html = `
      <html>
        <body>
          <a href="/products">Products</a>
          <a href="https://example.com/about">About Us</a>
          <a href="/contact" rel="nofollow">Contact</a>
        </body>
      </html>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({
      url: 'https://example.com/products',
      text: 'Products',
      rel: undefined,
    });
    expect(links[1]).toEqual({
      url: 'https://example.com/about',
      text: 'About Us',
      rel: undefined,
    });
    expect(links[2]).toEqual({
      url: 'https://example.com/contact',
      text: 'Contact',
      rel: 'nofollow',
    });
  });

  it('deduplicates links by URL', () => {
    const html = `
      <a href="/page">Link 1</a>
      <a href="/page">Link 2</a>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('Link 1');
  });

  it('skips non-http links', () => {
    const html = `
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:x@y.com">Email</a>
      <a href="tel:123">Phone</a>
      <a href="/real-page">Real</a>
    `;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/real-page');
  });

  it('handles empty href gracefully', () => {
    const html = `<a href="">Empty</a><a>No href</a>`;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });

  it('trims whitespace from link text', () => {
    const html = `<a href="/page">  Spaced Out  </a>`;
    const links = extractLinks(html, 'https://example.com');
    expect(links[0].text).toBe('Spaced Out');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL — module not found

**Step 3: Write implementation**

`packages/core/src/crawlers/link-extractor.ts`:
```typescript
import * as cheerio from 'cheerio';

const IGNORED_PROTOCOLS = ['javascript:', 'mailto:', 'tel:', 'data:', 'blob:'];

export function resolveUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  for (const protocol of IGNORED_PROTOCOLS) {
    if (trimmed.toLowerCase().startsWith(protocol)) return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

export interface ExtractedLink {
  url: string;
  text?: string;
  rel?: string;
}

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return;

    if (seen.has(resolved)) return;
    seen.add(resolved);

    const text = $(el).text().trim() || undefined;
    const rel = $(el).attr('rel') || undefined;

    links.push({ url: resolved, text, rel });
  });

  return links;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/ packages/core/tests/unit/crawlers/
git commit -m "feat(core): add link extractor utility with URL resolution"
```

---

## Task 3: Playwright Crawler Adapter

**Files:**
- Create: `packages/core/src/crawlers/playwright-crawler.ts`
- Create: `packages/core/tests/unit/crawlers/playwright-crawler.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/crawlers/playwright-crawler.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

function createMockPage(overrides: Partial<{
  html: string;
  title: string;
  url: string;
  status: number;
  contentType: string;
}> = {}): { page: Page; context: BrowserContext; browser: Browser } {
  const {
    html = '<html><head><title>Test</title></head><body><a href="/link">Link</a></body></html>',
    title = 'Test',
    url = 'https://example.com',
    status = 200,
    contentType = 'text/html',
  } = overrides;

  const mockResponse = {
    status: () => status,
    headers: () => ({ 'content-type': contentType }),
  } as unknown as Response;

  const mockPage = {
    goto: vi.fn().mockResolvedValue(mockResponse),
    content: vi.fn().mockResolvedValue(html),
    title: vi.fn().mockResolvedValue(title),
    url: vi.fn().mockReturnValue(url),
    waitForSelector: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Browser;

  return { page: mockPage, context: mockContext, browser: mockBrowser };
}

describe('PlaywrightCrawler', () => {
  let crawler: PlaywrightCrawler;
  let mocks: ReturnType<typeof createMockPage>;

  beforeEach(() => {
    mocks = createMockPage();
    crawler = new PlaywrightCrawler(mocks.browser);
  });

  it('has type "playwright"', () => {
    expect(crawler.type).toBe('playwright');
  });

  it('crawls a URL and returns CrawlResult', async () => {
    const result = await crawler.crawl('https://example.com');

    expect(mocks.browser.newContext).toHaveBeenCalled();
    expect(result.url).toBe('https://example.com');
    expect(result.html).toContain('<a href="/link">');
    expect(result.title).toBe('Test');
    expect(result.statusCode).toBe(200);
    expect(result.links).toHaveLength(1);
    expect(result.links[0].url).toBe('https://example.com/link');
    expect(result.metadata.crawlerType).toBe('playwright');
    expect(result.metadata.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('passes timeout option to page.goto', async () => {
    await crawler.crawl('https://example.com', { timeout: 5000 });
    expect(mocks.page.goto).toHaveBeenCalledWith('https://example.com', {
      timeout: 5000,
      waitUntil: 'domcontentloaded',
    });
  });

  it('waits for selector when provided', async () => {
    await crawler.crawl('https://example.com', {
      waitForSelector: '.content',
    });
    expect(mocks.page.waitForSelector).toHaveBeenCalledWith('.content', {
      timeout: 30000,
    });
  });

  it('sets custom user agent via context options', async () => {
    await crawler.crawl('https://example.com', {
      userAgent: 'SpatulaBot/1.0',
    });
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: 'SpatulaBot/1.0' }),
    );
  });

  it('sets custom headers via context options', async () => {
    await crawler.crawl('https://example.com', {
      headers: { 'X-Custom': 'value' },
    });
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        extraHTTPHeaders: { 'X-Custom': 'value' },
      }),
    );
  });

  it('throws CrawlError on navigation failure', async () => {
    (mocks.page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('net::ERR_NAME_NOT_RESOLVED'),
    );

    await expect(crawler.crawl('https://nonexistent.test')).rejects.toThrow('CRAWL_ERROR');
  });

  it('closes page and context even on error', async () => {
    (mocks.page.content as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('page crashed'),
    );

    await expect(crawler.crawl('https://example.com')).rejects.toThrow();
    expect(mocks.page.close).toHaveBeenCalled();
    expect(mocks.context.close).toHaveBeenCalled();
  });

  it('closes browser on close()', async () => {
    await crawler.close();
    expect(mocks.browser.close).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/crawlers/playwright-crawler.ts`:
```typescript
import type { Browser, BrowserContext, Page } from 'playwright';
import { CrawlError } from '@spatula/shared';
import { createLogger } from '@spatula/shared';
import type { Crawler, CrawlOptions, CrawlResult } from '../interfaces/crawler.js';
import { extractLinks } from './link-extractor.js';

const logger = createLogger('playwright-crawler');

export class PlaywrightCrawler implements Crawler {
  readonly type = 'playwright' as const;
  private browser: Browser;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async crawl(url: string, options?: CrawlOptions): Promise<CrawlResult> {
    const timeout = options?.timeout ?? 30000;
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      const contextOptions: Record<string, unknown> = {};
      if (options?.userAgent) {
        contextOptions.userAgent = options.userAgent;
      }
      if (options?.headers) {
        contextOptions.extraHTTPHeaders = options.headers;
      }

      context = await this.browser.newContext(contextOptions);
      page = await context.newPage();

      const startTime = Date.now();

      const response = await page.goto(url, {
        timeout,
        waitUntil: 'domcontentloaded',
      });

      if (options?.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout });
      }

      const html = await page.content();
      const title = await page.title();
      const statusCode = response?.status() ?? 0;
      const contentType = response?.headers()['content-type'] ?? undefined;
      const responseTimeMs = Date.now() - startTime;

      const links = extractLinks(html, url);

      logger.debug({ url, statusCode, linkCount: links.length, responseTimeMs }, 'page crawled');

      return {
        url,
        html,
        title: title || undefined,
        statusCode,
        contentType,
        links,
        metadata: {
          crawledAt: new Date(),
          responseTimeMs,
          contentLength: Buffer.byteLength(html, 'utf-8'),
          crawlerType: 'playwright',
        },
      };
    } catch (error) {
      logger.error({ url, error }, 'crawl failed');
      throw new CrawlError(`Failed to crawl ${url}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url, crawlerType: 'playwright' },
      });
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/playwright-crawler.ts packages/core/tests/unit/crawlers/
git commit -m "feat(core): add Playwright crawler adapter"
```

---

## Task 4: Firecrawl Crawler Adapter

**Files:**
- Create: `packages/core/src/crawlers/firecrawl-crawler.ts`
- Create: `packages/core/tests/unit/crawlers/firecrawl-crawler.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/crawlers/firecrawl-crawler.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirecrawlCrawler } from '../../../src/crawlers/firecrawl-crawler.js';

const mockScrape = vi.fn();

vi.mock('@mendable/firecrawl-js', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      scrape: mockScrape,
    })),
  };
});

describe('FirecrawlCrawler', () => {
  let crawler: FirecrawlCrawler;

  beforeEach(() => {
    vi.clearAllMocks();

    mockScrape.mockResolvedValue({
      success: true,
      html: '<html><head><title>Test Page</title></head><body><a href="/link">Link</a></body></html>',
      metadata: {
        title: 'Test Page',
        statusCode: 200,
        sourceURL: 'https://example.com',
      },
      links: ['https://example.com/link'],
    });

    crawler = new FirecrawlCrawler({ apiKey: 'test-key' });
  });

  it('has type "firecrawl"', () => {
    expect(crawler.type).toBe('firecrawl');
  });

  it('scrapes a URL and returns CrawlResult', async () => {
    const result = await crawler.crawl('https://example.com');

    expect(mockScrape).toHaveBeenCalledWith('https://example.com', {
      formats: ['html', 'links'],
      timeout: 30000,
    });
    expect(result.url).toBe('https://example.com');
    expect(result.html).toContain('<a href="/link">');
    expect(result.title).toBe('Test Page');
    expect(result.statusCode).toBe(200);
    expect(result.metadata.crawlerType).toBe('firecrawl');
  });

  it('extracts links from HTML when links array not in response', async () => {
    mockScrape.mockResolvedValue({
      success: true,
      html: '<html><body><a href="/page1">P1</a><a href="/page2">P2</a></body></html>',
      metadata: { title: 'Test', statusCode: 200, sourceURL: 'https://example.com' },
    });

    const result = await crawler.crawl('https://example.com');
    expect(result.links.length).toBeGreaterThanOrEqual(2);
  });

  it('passes custom timeout', async () => {
    await crawler.crawl('https://example.com', { timeout: 5000 });

    expect(mockScrape).toHaveBeenCalledWith('https://example.com', {
      formats: ['html', 'links'],
      timeout: 5000,
    });
  });

  it('throws CrawlError when scrape fails', async () => {
    mockScrape.mockResolvedValue({
      success: false,
      error: 'Rate limit exceeded',
    });

    await expect(crawler.crawl('https://example.com')).rejects.toThrow('CRAWL_ERROR');
  });

  it('throws CrawlError on network error', async () => {
    mockScrape.mockRejectedValue(new Error('Network timeout'));

    await expect(crawler.crawl('https://example.com')).rejects.toThrow('CRAWL_ERROR');
  });

  it('close() is a no-op (stateless)', async () => {
    await expect(crawler.close()).resolves.toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/crawlers/firecrawl-crawler.ts`:
```typescript
import FirecrawlApp from '@mendable/firecrawl-js';
import { CrawlError } from '@spatula/shared';
import { createLogger } from '@spatula/shared';
import type { Crawler, CrawlOptions, CrawlResult } from '../interfaces/crawler.js';
import { extractLinks } from './link-extractor.js';

const logger = createLogger('firecrawl-crawler');

export interface FirecrawlCrawlerOptions {
  apiKey: string;
  apiUrl?: string;
}

export class FirecrawlCrawler implements Crawler {
  readonly type = 'firecrawl' as const;
  private client: FirecrawlApp;

  constructor(options: FirecrawlCrawlerOptions) {
    this.client = new FirecrawlApp({
      apiKey: options.apiKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    });
  }

  async crawl(url: string, options?: CrawlOptions): Promise<CrawlResult> {
    const timeout = options?.timeout ?? 30000;
    const startTime = Date.now();

    try {
      const response = await this.client.scrape(url, {
        formats: ['html', 'links'],
        timeout,
      });

      if (!response.success) {
        throw new CrawlError(
          `Firecrawl scrape failed for ${url}: ${(response as { error?: string }).error ?? 'Unknown error'}`,
          { context: { url, crawlerType: 'firecrawl' } },
        );
      }

      const html = response.html ?? '';
      const title = response.metadata?.title ?? undefined;
      const statusCode = response.metadata?.statusCode ?? 200;
      const responseTimeMs = Date.now() - startTime;

      // Prefer extracting links from HTML for consistent format with Playwright adapter
      const links = extractLinks(html, url);

      logger.debug(
        { url, statusCode, linkCount: links.length, responseTimeMs },
        'page scraped via firecrawl',
      );

      return {
        url,
        html,
        title,
        statusCode,
        links,
        metadata: {
          crawledAt: new Date(),
          responseTimeMs,
          contentLength: Buffer.byteLength(html, 'utf-8'),
          crawlerType: 'firecrawl',
        },
      };
    } catch (error) {
      if (error instanceof CrawlError) throw error;

      logger.error({ url, error }, 'firecrawl scrape failed');
      throw new CrawlError(`Failed to scrape ${url}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url, crawlerType: 'firecrawl' },
      });
    }
  }

  async close(): Promise<void> {
    // Firecrawl is stateless HTTP — no cleanup needed
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/firecrawl-crawler.ts packages/core/tests/unit/crawlers/
git commit -m "feat(core): add Firecrawl crawler adapter"
```

---

## Task 5: Crawler Factory

Creates the right crawler adapter based on configuration. Centralizes Playwright browser launch logic.

**Files:**
- Create: `packages/core/src/crawlers/crawler-factory.ts`
- Create: `packages/core/tests/unit/crawlers/crawler-factory.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/crawlers/crawler-factory.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { CrawlerFactory } from '../../../src/crawlers/crawler-factory.js';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import { FirecrawlCrawler } from '../../../src/crawlers/firecrawl-crawler.js';

// Mock playwright to avoid launching real browsers in unit tests
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
      }),
      close: vi.fn(),
    }),
  },
}));

describe('CrawlerFactory', () => {
  it('creates a PlaywrightCrawler', async () => {
    const crawler = await CrawlerFactory.create({ type: 'playwright' });
    expect(crawler).toBeInstanceOf(PlaywrightCrawler);
    expect(crawler.type).toBe('playwright');
    await crawler.close();
  });

  it('creates a FirecrawlCrawler', async () => {
    const crawler = await CrawlerFactory.create({
      type: 'firecrawl',
      firecrawlApiKey: 'test-key',
    });
    expect(crawler).toBeInstanceOf(FirecrawlCrawler);
    expect(crawler.type).toBe('firecrawl');
  });

  it('throws on firecrawl without API key', async () => {
    await expect(
      CrawlerFactory.create({ type: 'firecrawl' }),
    ).rejects.toThrow('CRAWL_ERROR');
  });

  it('passes playwright launch options', async () => {
    const { chromium } = await import('playwright');
    await CrawlerFactory.create({
      type: 'playwright',
      playwrightOptions: { headless: true },
    });
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true });
  });

  it('passes firecrawl API URL', async () => {
    const crawler = await CrawlerFactory.create({
      type: 'firecrawl',
      firecrawlApiKey: 'key',
      firecrawlApiUrl: 'https://custom.api.com',
    });
    expect(crawler).toBeInstanceOf(FirecrawlCrawler);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/crawlers/crawler-factory.ts`:
```typescript
import { CrawlError } from '@spatula/shared';
import type { Crawler } from '../interfaces/crawler.js';
import { PlaywrightCrawler } from './playwright-crawler.js';
import { FirecrawlCrawler } from './firecrawl-crawler.js';

export interface CrawlerFactoryOptions {
  type: 'playwright' | 'firecrawl';
  playwrightOptions?: Record<string, unknown>;
  firecrawlApiKey?: string;
  firecrawlApiUrl?: string;
}

export class CrawlerFactory {
  static async create(options: CrawlerFactoryOptions): Promise<Crawler> {
    switch (options.type) {
      case 'playwright': {
        const { chromium } = await import('playwright');
        const browser = await chromium.launch(options.playwrightOptions ?? {});
        return new PlaywrightCrawler(browser);
      }

      case 'firecrawl': {
        if (!options.firecrawlApiKey) {
          throw new CrawlError('Firecrawl API key is required', {
            context: { crawlerType: 'firecrawl' },
          });
        }
        return new FirecrawlCrawler({
          apiKey: options.firecrawlApiKey,
          apiUrl: options.firecrawlApiUrl,
        });
      }

      default:
        throw new CrawlError(`Unknown crawler type: ${options.type as string}`, {
          context: { crawlerType: options.type },
        });
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/crawler-factory.ts packages/core/tests/unit/crawlers/
git commit -m "feat(core): add CrawlerFactory for creating crawler instances"
```

---

## Task 6: Crawler Comparison Utility

Runs both crawlers against the same URL and produces a structured comparison. This was a design requirement — the user wants to compare how each method performs.

**Files:**
- Create: `packages/core/src/crawlers/crawler-comparison.ts`
- Create: `packages/core/tests/unit/crawlers/crawler-comparison.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/crawlers/crawler-comparison.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { compareCrawlers } from '../../../src/crawlers/crawler-comparison.js';
import type { Crawler, CrawlResult } from '../../../src/interfaces/crawler.js';

function makeMockCrawler(type: 'playwright' | 'firecrawl', result: Partial<CrawlResult>): Crawler {
  const defaults: CrawlResult = {
    url: 'https://example.com',
    html: '<html><body>Hello</body></html>',
    title: 'Test',
    statusCode: 200,
    links: [{ url: 'https://example.com/a', text: 'A' }],
    metadata: {
      crawledAt: new Date(),
      responseTimeMs: 100,
      contentLength: 50,
      crawlerType: type,
    },
  };

  return {
    type,
    crawl: vi.fn().mockResolvedValue({ ...defaults, ...result }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('compareCrawlers', () => {
  it('returns comparison with both results', async () => {
    const playwrightCrawler = makeMockCrawler('playwright', {
      html: '<html><body>PW content</body></html>',
      links: [
        { url: 'https://example.com/a', text: 'A' },
        { url: 'https://example.com/b', text: 'B' },
      ],
      metadata: {
        crawledAt: new Date(),
        responseTimeMs: 500,
        contentLength: 200,
        crawlerType: 'playwright',
      },
    });

    const firecrawlCrawler = makeMockCrawler('firecrawl', {
      html: '<html><body>FC content</body></html>',
      links: [
        { url: 'https://example.com/a', text: 'A' },
        { url: 'https://example.com/c', text: 'C' },
      ],
      metadata: {
        crawledAt: new Date(),
        responseTimeMs: 300,
        contentLength: 180,
        crawlerType: 'firecrawl',
      },
    });

    const comparison = await compareCrawlers(
      'https://example.com',
      playwrightCrawler,
      firecrawlCrawler,
    );

    expect(comparison.url).toBe('https://example.com');
    expect(comparison.playwright.statusCode).toBe(200);
    expect(comparison.firecrawl.statusCode).toBe(200);
    expect(comparison.diff.responseTimeDiffMs).toBe(200);
    expect(comparison.diff.fasterCrawler).toBe('firecrawl');
    expect(comparison.diff.contentLengthDiff).toBe(20);
    expect(comparison.diff.linksOnlyInPlaywright).toEqual(['https://example.com/b']);
    expect(comparison.diff.linksOnlyInFirecrawl).toEqual(['https://example.com/c']);
    expect(comparison.diff.linksInBoth).toEqual(['https://example.com/a']);
  });

  it('handles crawler failure gracefully', async () => {
    const working = makeMockCrawler('playwright', {});
    const failing: Crawler = {
      type: 'firecrawl',
      crawl: vi.fn().mockRejectedValue(new Error('API down')),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const comparison = await compareCrawlers('https://example.com', working, failing);

    expect(comparison.playwright.statusCode).toBe(200);
    expect(comparison.firecrawl).toBeNull();
    expect(comparison.errors).toHaveLength(1);
    expect(comparison.errors[0].crawler).toBe('firecrawl');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/crawlers/crawler-comparison.ts`:
```typescript
import { createLogger } from '@spatula/shared';
import type { Crawler, CrawlResult, CrawlOptions } from '../interfaces/crawler.js';

const logger = createLogger('crawler-comparison');

export interface CrawlerComparisonResult {
  url: string;
  playwright: CrawlResult | null;
  firecrawl: CrawlResult | null;
  diff: {
    responseTimeDiffMs: number;
    fasterCrawler: 'playwright' | 'firecrawl' | 'tie';
    contentLengthDiff: number;
    linksOnlyInPlaywright: string[];
    linksOnlyInFirecrawl: string[];
    linksInBoth: string[];
  };
  errors: Array<{ crawler: 'playwright' | 'firecrawl'; error: string }>;
}

export async function compareCrawlers(
  url: string,
  playwrightCrawler: Crawler,
  firecrawlCrawler: Crawler,
  options?: CrawlOptions,
): Promise<CrawlerComparisonResult> {
  const errors: CrawlerComparisonResult['errors'] = [];

  const [playwrightResult, firecrawlResult] = await Promise.allSettled([
    playwrightCrawler.crawl(url, options),
    firecrawlCrawler.crawl(url, options),
  ]);

  const pw =
    playwrightResult.status === 'fulfilled' ? playwrightResult.value : null;
  const fc =
    firecrawlResult.status === 'fulfilled' ? firecrawlResult.value : null;

  if (playwrightResult.status === 'rejected') {
    const msg = (playwrightResult.reason as Error).message;
    logger.warn({ url, error: msg }, 'playwright crawl failed in comparison');
    errors.push({ crawler: 'playwright', error: msg });
  }

  if (firecrawlResult.status === 'rejected') {
    const msg = (firecrawlResult.reason as Error).message;
    logger.warn({ url, error: msg }, 'firecrawl crawl failed in comparison');
    errors.push({ crawler: 'firecrawl', error: msg });
  }

  const pwTime = pw?.metadata.responseTimeMs ?? 0;
  const fcTime = fc?.metadata.responseTimeMs ?? 0;
  const pwLinks = new Set(pw?.links.map((l) => l.url) ?? []);
  const fcLinks = new Set(fc?.links.map((l) => l.url) ?? []);

  const linksInBoth = [...pwLinks].filter((l) => fcLinks.has(l));
  const linksOnlyInPlaywright = [...pwLinks].filter((l) => !fcLinks.has(l));
  const linksOnlyInFirecrawl = [...fcLinks].filter((l) => !pwLinks.has(l));

  let fasterCrawler: 'playwright' | 'firecrawl' | 'tie' = 'tie';
  if (pw && fc) {
    if (pwTime < fcTime) fasterCrawler = 'playwright';
    else if (fcTime < pwTime) fasterCrawler = 'firecrawl';
  }

  return {
    url,
    playwright: pw,
    firecrawl: fc,
    diff: {
      responseTimeDiffMs: Math.abs(pwTime - fcTime),
      fasterCrawler,
      contentLengthDiff: Math.abs(
        (pw?.metadata.contentLength ?? 0) - (fc?.metadata.contentLength ?? 0),
      ),
      linksOnlyInPlaywright,
      linksOnlyInFirecrawl,
      linksInBoth,
    },
    errors,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/crawler-comparison.ts packages/core/tests/unit/crawlers/
git commit -m "feat(core): add crawler comparison utility for benchmarking adapters"
```

---

## Task 7: Crawlers Barrel Export & Core Re-export

Wire up the crawler modules into the package export tree.

**Files:**
- Create: `packages/core/src/crawlers/index.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Create barrel export**

`packages/core/src/crawlers/index.ts`:
```typescript
export { extractLinks, resolveUrl } from './link-extractor.js';
export type { ExtractedLink } from './link-extractor.js';
export { PlaywrightCrawler } from './playwright-crawler.js';
export { FirecrawlCrawler } from './firecrawl-crawler.js';
export type { FirecrawlCrawlerOptions } from './firecrawl-crawler.js';
export { CrawlerFactory } from './crawler-factory.js';
export type { CrawlerFactoryOptions } from './crawler-factory.js';
export { compareCrawlers } from './crawler-comparison.js';
export type { CrawlerComparisonResult } from './crawler-comparison.js';
```

**Step 2: Update core index.ts**

Add to `packages/core/src/index.ts`:
```typescript
// Crawlers
export * from './crawlers/index.js';
```

**Step 3: Verify build**

Run: `pnpm build`
Expected: All packages compile

**Step 4: Verify tests still pass**

Run: `pnpm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/core/src/crawlers/index.ts packages/core/src/index.ts
git commit -m "feat(core): add crawlers barrel export and wire into package"
```

---

## Task 8: Integration Test with HTML Fixtures

Create realistic HTML fixtures and integration tests that verify end-to-end crawl result quality without hitting real networks.

**Files:**
- Create: `packages/core/tests/fixtures/single-product.html`
- Create: `packages/core/tests/fixtures/product-listing.html`
- Create: `packages/core/tests/integration/crawlers/crawl-fixtures.test.ts`

**Step 1: Create HTML fixtures**

`packages/core/tests/fixtures/single-product.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sennheiser HD 650 - AudioStore</title>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/headphones">Headphones</a>
    <a href="/amps">Amplifiers</a>
  </nav>
  <main>
    <h1>Sennheiser HD 650</h1>
    <p class="price">$299.99</p>
    <p class="description">Open-back audiophile headphone with exceptional sound quality.</p>
    <ul class="specs">
      <li>Type: Over-ear, Open-back</li>
      <li>Impedance: 300 Ohm</li>
      <li>Driver: Dynamic</li>
      <li>Frequency: 10 - 41,000 Hz</li>
    </ul>
    <div class="related">
      <a href="/products/hd600">Sennheiser HD 600</a>
      <a href="/products/hd660s">Sennheiser HD 660S</a>
      <a href="https://sennheiser.com/hd650" rel="nofollow">Official Page</a>
    </div>
  </main>
  <footer>
    <a href="/privacy">Privacy</a>
    <a href="mailto:support@audiostore.com">Contact</a>
  </footer>
</body>
</html>
```

`packages/core/tests/fixtures/product-listing.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Headphones - AudioStore</title>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/headphones">Headphones</a>
  </nav>
  <main>
    <h1>Headphones</h1>
    <div class="product-grid">
      <div class="product">
        <a href="/products/hd650">
          <h2>Sennheiser HD 650</h2>
          <p>$299.99</p>
        </a>
      </div>
      <div class="product">
        <a href="/products/lcd-x">
          <h2>Audeze LCD-X</h2>
          <p>$1,199.00</p>
        </a>
      </div>
      <div class="product">
        <a href="/products/sundara">
          <h2>HiFiMAN Sundara</h2>
          <p>$349.00</p>
        </a>
      </div>
    </div>
    <div class="pagination">
      <a href="/headphones?page=1" class="active">1</a>
      <a href="/headphones?page=2">2</a>
      <a href="/headphones?page=3">3</a>
    </div>
  </main>
</body>
</html>
```

**Step 2: Write integration test**

`packages/core/tests/integration/crawlers/crawl-fixtures.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import { CrawlResult } from '../../../src/interfaces/crawler.js';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

function loadFixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '../../fixtures', name), 'utf-8');
}

function createMockBrowserForHtml(html: string, url: string): Browser {
  const mockResponse = {
    status: () => 200,
    headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
  } as unknown as Response;

  const mockPage = {
    goto: vi.fn().mockResolvedValue(mockResponse),
    content: vi.fn().mockResolvedValue(html),
    title: vi.fn().mockResolvedValue(
      html.match(/<title>(.*?)<\/title>/)?.[1] ?? '',
    ),
    url: vi.fn().mockReturnValue(url),
    waitForSelector: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;

  return {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Browser;
}

describe('Crawl Fixtures — Single Product Page', () => {
  let result: CrawlResult;

  beforeEach(async () => {
    const html = loadFixture('single-product.html');
    const browser = createMockBrowserForHtml(html, 'https://audiostore.com/products/hd650');
    const crawler = new PlaywrightCrawler(browser);
    const parsed = await crawler.crawl('https://audiostore.com/products/hd650');
    result = CrawlResult.parse(parsed);
  });

  it('parses as valid CrawlResult', () => {
    expect(result.statusCode).toBe(200);
    expect(result.title).toBe('Sennheiser HD 650 - AudioStore');
  });

  it('extracts navigation links', () => {
    const urls = result.links.map((l) => l.url);
    expect(urls).toContain('https://audiostore.com/');
    expect(urls).toContain('https://audiostore.com/headphones');
    expect(urls).toContain('https://audiostore.com/amps');
  });

  it('extracts related product links', () => {
    const urls = result.links.map((l) => l.url);
    expect(urls).toContain('https://audiostore.com/products/hd600');
    expect(urls).toContain('https://audiostore.com/products/hd660s');
    expect(urls).toContain('https://sennheiser.com/hd650');
  });

  it('excludes mailto links', () => {
    const urls = result.links.map((l) => l.url);
    const mailtoLinks = urls.filter((u) => u.includes('mailto'));
    expect(mailtoLinks).toHaveLength(0);
  });

  it('captures nofollow rel attribute', () => {
    const sennLink = result.links.find((l) => l.url.includes('sennheiser.com'));
    expect(sennLink?.rel).toBe('nofollow');
  });
});

describe('Crawl Fixtures — Product Listing Page', () => {
  let result: CrawlResult;

  beforeEach(async () => {
    const html = loadFixture('product-listing.html');
    const browser = createMockBrowserForHtml(html, 'https://audiostore.com/headphones');
    const crawler = new PlaywrightCrawler(browser);
    const parsed = await crawler.crawl('https://audiostore.com/headphones');
    result = CrawlResult.parse(parsed);
  });

  it('extracts all product links', () => {
    const productUrls = result.links
      .map((l) => l.url)
      .filter((u) => u.includes('/products/'));
    expect(productUrls).toHaveLength(3);
    expect(productUrls).toContain('https://audiostore.com/products/hd650');
    expect(productUrls).toContain('https://audiostore.com/products/lcd-x');
    expect(productUrls).toContain('https://audiostore.com/products/sundara');
  });

  it('extracts pagination links', () => {
    const pageUrls = result.links
      .map((l) => l.url)
      .filter((u) => u.includes('page='));
    expect(pageUrls.length).toBeGreaterThanOrEqual(2);
  });

  it('metadata has correct crawler type', () => {
    expect(result.metadata.crawlerType).toBe('playwright');
  });
});
```

**Step 3: Run tests**

Run: `cd packages/core && pnpm test`
Expected: All tests pass (unit + integration)

**Step 4: Commit**

```bash
git add packages/core/tests/fixtures/ packages/core/tests/integration/
git commit -m "test(core): add HTML fixtures and integration tests for crawler adapters"
```

---

## Task 9: Final Verification & Build

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across all packages

**Step 2: Run full build**

Run: `pnpm build`
Expected: All packages compile

**Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

**Step 4: Run lint**

Run: `pnpm lint`
Expected: Clean or only intentional warnings

**Step 5: Run format check**

Run: `pnpm format:check`
Expected: All files formatted (run `pnpm format` if not)

**Step 6: Commit any fixes**

```bash
git add -u
git commit -m "chore: Phase 2 final verification — all tests pass, builds clean"
```

---

## Summary

Phase 2 delivers:
- **Link Extractor** — Shared utility for HTML link discovery with URL resolution, dedup, and filtering
- **Playwright Adapter** — Full `Crawler` implementation using Playwright browser automation with configurable options
- **Firecrawl Adapter** — Full `Crawler` implementation using Firecrawl managed scraping API
- **Crawler Factory** — Creates crawler instances from config, handles Playwright browser lifecycle
- **Crawler Comparison** — Runs both adapters against same URL, produces structured diff (response time, content length, link overlap)
- **HTML Fixtures** — Realistic product page fixtures for testing extraction quality
- **~9 commits** with focused, atomic changes

Both adapters:
- Implement the `Crawler` interface from Phase 1
- Return validated `CrawlResult` with links, metadata, timing
- Use shared `extractLinks` for consistent link discovery
- Throw `CrawlError` with context on failure
- Log operations via shared `createLogger`
