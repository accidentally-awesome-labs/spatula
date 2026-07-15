import { CrawlError } from '@accidentally-awesome-labs/spatula-shared';
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
