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
