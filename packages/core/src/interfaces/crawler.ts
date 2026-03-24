import { z } from 'zod';

export const CrawlOptions = z.object({
  timeout: z.number().default(30000),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string()).optional(),
  userAgent: z.string().optional(),
  // Proxy configuration
  proxy: z.object({
    url: z.string(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
  // Cookie injection
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string().default('/'),
    httpOnly: z.boolean().default(false),
    secure: z.boolean().default(false),
  })).optional(),
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
    proxyUsed: z.boolean().default(false),
  }),
});

export type CrawlResult = z.infer<typeof CrawlResult>;

export interface Crawler {
  readonly type: 'playwright' | 'firecrawl';
  crawl(url: string, options?: CrawlOptions): Promise<CrawlResult>;
  close(): Promise<void>;
}
