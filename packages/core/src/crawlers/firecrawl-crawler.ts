import Firecrawl from '@mendable/firecrawl-js';
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
  private client: Firecrawl;

  constructor(options: FirecrawlCrawlerOptions) {
    this.client = new Firecrawl({
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

      const html = response.html ?? '';
      const title = response.metadata?.title ?? undefined;
      const statusCode = response.metadata?.statusCode ?? 200;
      const contentType = response.metadata?.contentType ?? undefined;
      const responseTimeMs = Date.now() - startTime;

      // Use shared link extractor for consistent output with Playwright adapter
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
        contentType,
        links,
        metadata: {
          crawledAt: new Date(),
          responseTimeMs,
          contentLength: Buffer.byteLength(html, 'utf-8'),
          crawlerType: 'firecrawl',
          proxyUsed: false,
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
