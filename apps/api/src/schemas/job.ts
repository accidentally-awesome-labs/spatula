import { z } from '@hono/zod-openapi';
import { isValidCrawlUrl } from '@spatula/core';

export const PRIVATE_CRAWL_URL_REJECTION_MESSAGE =
  'Private, loopback, link-local, and reserved seed URLs are disabled in production';

export function allowPrivateCrawlUrls(): boolean {
  if (process.env.SPATULA_ALLOW_PRIVATE_CRAWL_URLS === '1') return true;
  if (process.env.SPATULA_ALLOW_PRIVATE_CRAWL_URLS === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isAllowedCreateJobSeedUrl(url: string): boolean {
  return isHttpUrl(url) && (allowPrivateCrawlUrls() || isValidCrawlUrl(url));
}

const seedUrlSchema = z
  .string()
  .url()
  .refine(isHttpUrl, 'Seed URLs must use http or https')
  .refine(isAllowedCreateJobSeedUrl, PRIVATE_CRAWL_URL_REJECTION_MESSAGE);

export const createJobSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1),
  seedUrls: z.array(seedUrlSchema).min(1),
  crawl: z.object({
    maxDepth: z.number().int().min(0).max(10).default(2),
    maxPages: z.number().int().min(1).default(1000),
    concurrency: z.number().int().min(1).max(20).default(5),
    crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
  }),
  schema: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']),
    userFields: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string(),
          type: z.enum([
            'string',
            'number',
            'boolean',
            'url',
            'currency',
            'enum',
            'array',
            'object',
          ]),
          required: z.boolean().default(false),
        }),
      )
      .optional(),
    evolutionConfig: z
      .object({
        enabled: z.boolean().default(true),
        batchSize: z.number().int().min(1).default(10),
        maxFields: z.number().int().min(1).default(50),
      })
      .optional(),
  }),
  llm: z.object({
    primaryModel: z.string().min(1).default('deepseek/deepseek-v4-flash'),
    modelOverrides: z.record(z.string()).optional(),
  }),
  webhooks: z
    .object({
      url: z.string().url(),
      secret: z.string().min(16).optional(),
      events: z
        .array(
          z.enum([
            'job.completed',
            'job.failed',
            'job.cancelled',
            'export.completed',
            'action.pending',
          ]),
        )
        .default(['job.completed', 'job.failed']),
    })
    .optional(),
  reconciliation: z
    .object({
      matchStrategy: z
        .enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted'])
        .default('fuzzy_name'),
      conflictResolution: z
        .enum(['most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved'])
        .default('most_common'),
      sourcePriority: z.array(z.string()).optional(),
      fuzzyMatchThreshold: z.number().min(0).max(1).default(0.85),
      enableLLMMatching: z.boolean().default(true),
    })
    .optional(),
});

export type CreateJobBody = z.infer<typeof createJobSchema>;

export const listJobsQuerySchema = z.object({
  status: z
    .enum([
      'pending',
      'queued',
      'running',
      'paused',
      'reconciling',
      'completed',
      'failed',
      'cancelled',
    ])
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const patchJobSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel', 'reconcile']),
});

export type PatchJobBody = z.infer<typeof patchJobSchema>;
