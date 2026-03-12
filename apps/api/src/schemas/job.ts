import { z } from 'zod';

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
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
