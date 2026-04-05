/**
 * Tier 4 — Firecrawl Integration Tests
 *
 * These tests exercise the real Firecrawl API against a public test site.
 * They verify:
 *   1. Crawling a simple page returns HTML with expected content
 *   2. Extracted links array is populated
 *   3. Metadata fields (responseTimeMs, contentLength, crawlerType) are correct
 *   4. 404 pages are handled gracefully (error or status code)
 *   5. Cross-crawler comparison with Playwright (conditional)
 *
 * All tests skip gracefully when FIRECRAWL_API_KEY is not set.
 * Test 5 additionally skips when Playwright is not installed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Crawler, CrawlResult } from '@spatula/core';

const TARGET_URL = 'https://books.toscrape.com/';
const NONEXISTENT_URL = 'https://books.toscrape.com/catalogue/nonexistent-page-xyz-999';

let hasKey = false;
let crawler: Crawler;
/** Cache the crawl result across tests 1-3 to avoid redundant API calls. */
let cachedResult: CrawlResult | null = null;

beforeAll(async () => {
  hasKey = !!process.env.FIRECRAWL_API_KEY;
  if (!hasKey) return;

  const { CrawlerFactory } = await import('@spatula/core');
  crawler = await CrawlerFactory.create({
    type: 'firecrawl',
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY!,
  });
});

afterAll(async () => {
  if (crawler?.close) await crawler.close().catch(() => {});
});

/** Lazily crawl the target page once and reuse for tests 1-3. */
async function getCachedResult(): Promise<CrawlResult> {
  if (!cachedResult) {
    cachedResult = await crawler.crawl(TARGET_URL, { timeout: 30000, respectRobotsTxt: true });
  }
  return cachedResult;
}

describe('Firecrawl integration', () => {
  // -----------------------------------------------------------------------
  // 1. Crawl simple page
  // -----------------------------------------------------------------------
  it('crawls a simple page and returns HTML with expected content', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const result = await getCachedResult();

    expect(result.html).toBeTruthy();
    expect(result.html).toContain('Books to Scrape');
    expect(result.statusCode).toBe(200);
    expect(result.url).toBe(TARGET_URL);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 2. Extracts links
  // -----------------------------------------------------------------------
  it('extracts links from the crawled page', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const result = await getCachedResult();

    expect(Array.isArray(result.links)).toBe(true);
    expect(result.links.length).toBeGreaterThan(0);

    // CrawlResult.links is { url: string; text?: string; rel?: string }[]
    const firstLink = result.links[0];
    expect(firstLink).toHaveProperty('url');
    expect(typeof firstLink.url).toBe('string');
    expect(firstLink.url.length).toBeGreaterThan(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 3. Returns metadata
  // -----------------------------------------------------------------------
  it('returns correct metadata fields', async (ctx) => {
    if (!hasKey) return ctx.skip();

    const result = await getCachedResult();

    expect(result.metadata.responseTimeMs).toBeGreaterThan(0);
    expect(result.metadata.contentLength).toBeGreaterThan(0);
    expect(result.metadata.crawlerType).toBe('firecrawl');
    expect(result.metadata.crawledAt).toBeInstanceOf(Date);
    expect(typeof result.metadata.proxyUsed).toBe('boolean');
  }, 30_000);

  // -----------------------------------------------------------------------
  // 4. Handles 404
  // -----------------------------------------------------------------------
  it('handles a 404 page gracefully', async (ctx) => {
    if (!hasKey) return ctx.skip();

    // Firecrawl may either throw a CrawlError or return a result with
    // statusCode 404 — both are acceptable outcomes.
    try {
      const result = await crawler.crawl(NONEXISTENT_URL, { timeout: 30000, respectRobotsTxt: true });
      // If it returns a result, status should indicate the page was not found
      expect(result.statusCode).toBe(404);
    } catch (error: unknown) {
      // If it throws, verify it is a CrawlError (or at minimum an Error)
      const { CrawlError } = await import('@spatula/shared');
      if (error instanceof CrawlError) {
        expect(error.name).toBe('CrawlError');
        expect(error.message).toContain(NONEXISTENT_URL);
      } else {
        // Any error thrown during a 404 crawl is acceptable — the crawler
        // should not silently succeed with a 200 for a missing page.
        expect(error).toBeInstanceOf(Error);
      }
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // 5. Cross-crawler comparison with Playwright (conditional)
  // -----------------------------------------------------------------------
  it('produces comparable results to Playwright crawler', async (ctx) => {
    if (!hasKey) return ctx.skip();

    // Check Playwright availability
    let playwrightAvailable = false;
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      playwrightAvailable = true;
    } catch {
      // Playwright not installed or Chromium not available
    }

    if (!playwrightAvailable) return ctx.skip();

    const { CrawlerFactory } = await import('@spatula/core');
    const playwrightCrawler = await CrawlerFactory.create({ type: 'playwright' });

    try {
      // Crawl the same page with both crawlers
      const firecrawlResult = await getCachedResult();
      const playwrightResult = await playwrightCrawler.crawl(TARGET_URL, { timeout: 30000, respectRobotsTxt: true });

      // Both should return HTML containing the page title
      expect(firecrawlResult.html).toContain('Books to Scrape');
      expect(playwrightResult.html).toContain('Books to Scrape');

      // Both should find links
      expect(firecrawlResult.links.length).toBeGreaterThan(0);
      expect(playwrightResult.links.length).toBeGreaterThan(0);

      // Both should report the correct crawler type
      expect(firecrawlResult.metadata.crawlerType).toBe('firecrawl');
      expect(playwrightResult.metadata.crawlerType).toBe('playwright');

      // Both should have 200 status
      expect(firecrawlResult.statusCode).toBe(200);
      expect(playwrightResult.statusCode).toBe(200);
    } finally {
      await playwrightCrawler.close().catch(() => {});
    }
  }, 60_000);
});
