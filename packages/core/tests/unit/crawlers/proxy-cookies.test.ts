import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import type { CrawlOptions } from '../../../src/interfaces/crawler.js';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

function createMockBrowser(
  overrides: Partial<{
    html: string;
    title: string;
    status: number;
    contentType: string;
  }> = {},
) {
  const {
    html = '<html><head><title>Test</title></head><body>Test</body></html>',
    title = 'Test',
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
    url: vi.fn().mockReturnValue('https://example.com'),
    waitForSelector: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Browser;

  return { mockBrowser, mockContext, mockPage };
}

describe('PlaywrightCrawler proxy support', () => {
  it('passes proxy config to browser context', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    const options: CrawlOptions = {
      timeout: 30000,
      proxy: {
        url: 'socks5://127.0.0.1:1080',
        username: 'user',
        password: 'pass',
      },
    };

    await crawler.crawl('https://example.com', options);

    expect(mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: {
          server: 'socks5://127.0.0.1:1080',
          username: 'user',
          password: 'pass',
        },
      }),
    );
  });

  it('passes proxy without credentials when only url provided', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    const options: CrawlOptions = {
      timeout: 30000,
      proxy: { url: 'http://proxy.example.com:8080' },
    };

    await crawler.crawl('https://example.com', options);

    const contextArgs = (mockBrowser.newContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(contextArgs.proxy).toEqual({
      server: 'http://proxy.example.com:8080',
    });
    expect(contextArgs.proxy.username).toBeUndefined();
    expect(contextArgs.proxy.password).toBeUndefined();
  });

  it('does not set proxy when not provided', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    await crawler.crawl('https://example.com');

    const contextArgs = (mockBrowser.newContext as ReturnType<typeof vi.fn>).mock.calls[0][0] ?? {};
    expect(contextArgs.proxy).toBeUndefined();
  });

  it('sets proxyUsed to true in metadata when proxy is configured', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    const result = await crawler.crawl('https://example.com', {
      timeout: 30000,
      proxy: { url: 'http://proxy:8080' },
    });

    expect(result.metadata.proxyUsed).toBe(true);
  });

  it('sets proxyUsed to false in metadata when no proxy', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    const result = await crawler.crawl('https://example.com');

    expect(result.metadata.proxyUsed).toBe(false);
  });
});

describe('PlaywrightCrawler cookie support', () => {
  it('sets cookies on context before navigation', async () => {
    const { mockBrowser, mockContext, mockPage } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    const options: CrawlOptions = {
      timeout: 30000,
      cookies: [
        { name: 'session_id', value: 'abc123', domain: '.example.com', path: '/', httpOnly: false, secure: false },
        { name: 'csrf', value: 'xyz789', domain: '.example.com', path: '/', httpOnly: true, secure: true },
      ],
    };

    await crawler.crawl('https://example.com', options);

    // Cookies should be set
    expect(mockContext.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'session_id',
        value: 'abc123',
        domain: '.example.com',
        path: '/',
        httpOnly: false,
        secure: false,
      }),
      expect.objectContaining({
        name: 'csrf',
        value: 'xyz789',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
      }),
    ]);

    // Cookies should be set BEFORE page navigation
    const addCookiesOrder = (mockContext.addCookies as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const gotoOrder = (mockPage.goto as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(addCookiesOrder).toBeLessThan(gotoOrder);
  });

  it('does not call addCookies when no cookies provided', async () => {
    const { mockBrowser, mockContext } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    await crawler.crawl('https://example.com');

    expect(mockContext.addCookies).not.toHaveBeenCalled();
  });

  it('does not call addCookies when cookies array is empty', async () => {
    const { mockBrowser, mockContext } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser);

    await crawler.crawl('https://example.com', {
      timeout: 30000,
      cookies: [],
    });

    expect(mockContext.addCookies).not.toHaveBeenCalled();
  });
});
