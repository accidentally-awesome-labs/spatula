import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlError } from '@spatula/shared';
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

  it('throws CrawlError when scrape throws an SDK error', async () => {
    mockScrape.mockRejectedValue(new Error('Rate limit exceeded'));

    await expect(crawler.crawl('https://example.com')).rejects.toThrow(CrawlError);
  });

  it('throws CrawlError on network error', async () => {
    mockScrape.mockRejectedValue(new Error('Network timeout'));

    await expect(crawler.crawl('https://example.com')).rejects.toThrow(CrawlError);
  });

  it('close() is a no-op (stateless)', async () => {
    await expect(crawler.close()).resolves.toBeUndefined();
  });
});
