import { z } from '@hono/zod-openapi';

export const createJobSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1),
  seedUrls: z.array(z.string().url()).min(1),
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
          type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
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
    primaryModel: z.string().min(1).default('anthropic/claude-sonnet-4-20250514'),
    modelOverrides: z.record(z.string()).optional(),
  }),
  webhooks: z
    .object({
      url: z.string().url(),
      secret: z.string().min(16).optional(),
      events: z
        .array(
          z.enum(['job.completed', 'job.failed', 'job.cancelled', 'export.completed', 'action.pending']),
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
    .enum(['pending', 'queued', 'running', 'paused', 'reconciling', 'completed', 'failed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const patchJobSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel', 'reconcile']),
});

export type PatchJobBody = z.infer<typeof patchJobSchema>;
