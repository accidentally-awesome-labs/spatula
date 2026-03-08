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
