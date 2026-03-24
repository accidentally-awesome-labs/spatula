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
      // Proxy support
      if (options?.proxy) {
        contextOptions.proxy = {
          server: options.proxy.url,
          ...(options.proxy.username ? { username: options.proxy.username } : {}),
          ...(options.proxy.password ? { password: options.proxy.password } : {}),
        };
      }

      context = await this.browser.newContext(contextOptions);

      // Cookie support — set cookies before creating page
      if (options?.cookies?.length) {
        await context.addCookies(options.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? '/',
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? false,
        })));
      }

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
          proxyUsed: !!options?.proxy,
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
