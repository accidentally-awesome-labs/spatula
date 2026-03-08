import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlError } from '@spatula/shared';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

function createMockPage(
  overrides: Partial<{
    html: string;
    title: string;
    url: string;
    status: number;
    contentType: string;
  }> = {},
): { page: Page; context: BrowserContext; browser: Browser } {
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

    await expect(crawler.crawl('https://nonexistent.test')).rejects.toThrow(CrawlError);
  });

  it('closes page and context even on error', async () => {
    (mocks.page.content as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('page crashed'));

    await expect(crawler.crawl('https://example.com')).rejects.toThrow();
    expect(mocks.page.close).toHaveBeenCalled();
    expect(mocks.context.close).toHaveBeenCalled();
  });

  it('closes browser on close()', async () => {
    await crawler.close();
    expect(mocks.browser.close).toHaveBeenCalled();
  });
});
