import { z } from 'zod';

export const CrawlOptions = z.object({
  timeout: z.number().default(30000),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string()).optional(),
  userAgent: z.string().optional(),
});

export type CrawlOptions = z.infer<typeof CrawlOptions>;

export const CrawlResult = z.object({
  url: z.string().url(),
  html: z.string(),
  title: z.string().optional(),
  statusCode: z.number(),
  contentType: z.string().optional(),
  links: z.array(
    z.object({
      url: z.string(),
      text: z.string().optional(),
      rel: z.string().optional(),
    }),
  ),
  metadata: z.object({
    crawledAt: z.coerce.date(),
    responseTimeMs: z.number(),
    contentLength: z.number(),
    crawlerType: z.enum(['playwright', 'firecrawl']),
  }),
});

export type CrawlResult = z.infer<typeof CrawlResult>;

export interface Crawler {
  readonly type: 'playwright' | 'firecrawl';
  crawl(url: string, options?: CrawlOptions): Promise<CrawlResult>;
  close(): Promise<void>;
}
