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
    ).rejects.toThrow();
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
