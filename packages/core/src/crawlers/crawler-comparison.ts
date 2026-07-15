import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { Crawler, CrawlResult, CrawlOptions } from '../interfaces/crawler.js';

const logger = createLogger('crawler-comparison');

export interface CrawlerComparisonResult {
  url: string;
  playwright: CrawlResult | null;
  firecrawl: CrawlResult | null;
  diff: {
    responseTimeDiffMs: number;
    fasterCrawler: 'playwright' | 'firecrawl' | 'tie';
    contentLengthDiff: number;
    linksOnlyInPlaywright: string[];
    linksOnlyInFirecrawl: string[];
    linksInBoth: string[];
  };
  errors: Array<{ crawler: 'playwright' | 'firecrawl'; error: string }>;
}

export async function compareCrawlers(
  url: string,
  playwrightCrawler: Crawler,
  firecrawlCrawler: Crawler,
  options?: CrawlOptions,
): Promise<CrawlerComparisonResult> {
  const errors: CrawlerComparisonResult['errors'] = [];

  const [playwrightResult, firecrawlResult] = await Promise.allSettled([
    playwrightCrawler.crawl(url, options),
    firecrawlCrawler.crawl(url, options),
  ]);

  const pw = playwrightResult.status === 'fulfilled' ? playwrightResult.value : null;
  const fc = firecrawlResult.status === 'fulfilled' ? firecrawlResult.value : null;

  if (playwrightResult.status === 'rejected') {
    const msg = (playwrightResult.reason as Error).message;
    logger.warn({ url, error: msg }, 'playwright crawl failed in comparison');
    errors.push({ crawler: 'playwright', error: msg });
  }

  if (firecrawlResult.status === 'rejected') {
    const msg = (firecrawlResult.reason as Error).message;
    logger.warn({ url, error: msg }, 'firecrawl crawl failed in comparison');
    errors.push({ crawler: 'firecrawl', error: msg });
  }

  const pwTime = pw?.metadata.responseTimeMs ?? 0;
  const fcTime = fc?.metadata.responseTimeMs ?? 0;
  const pwLinks = new Set(pw?.links.map((l) => l.url) ?? []);
  const fcLinks = new Set(fc?.links.map((l) => l.url) ?? []);

  const linksInBoth = [...pwLinks].filter((l) => fcLinks.has(l));
  const linksOnlyInPlaywright = [...pwLinks].filter((l) => !fcLinks.has(l));
  const linksOnlyInFirecrawl = [...fcLinks].filter((l) => !pwLinks.has(l));

  let fasterCrawler: 'playwright' | 'firecrawl' | 'tie' = 'tie';
  if (pw && fc) {
    if (pwTime < fcTime) fasterCrawler = 'playwright';
    else if (fcTime < pwTime) fasterCrawler = 'firecrawl';
  }

  return {
    url,
    playwright: pw,
    firecrawl: fc,
    diff: {
      responseTimeDiffMs: Math.abs(pwTime - fcTime),
      fasterCrawler,
      contentLengthDiff: Math.abs(
        (pw?.metadata.contentLength ?? 0) - (fc?.metadata.contentLength ?? 0),
      ),
      linksOnlyInPlaywright,
      linksOnlyInFirecrawl,
      linksInBoth,
    },
    errors,
  };
}
