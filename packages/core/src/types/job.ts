import { z } from 'zod';
import { FieldDefinition } from './schema.js';

export const RelevanceThresholds = z.object({
  requiredMin: z.number().default(0.85),
  optionalMin: z.number().default(0.4),
  rareBelow: z.number().default(0.4),
  minCategorySampleSize: z.number().default(5),
});
export type RelevanceThresholds = z.infer<typeof RelevanceThresholds>;

export const EvolutionConfig = z.object({
  enabled: z.boolean(),
  batchSize: z.number().default(10),
  maxFields: z.number().default(50),
  relevanceThresholds: RelevanceThresholds.default({}),
  tableStrategy: z.enum(['single', 'multi', 'auto']).default('auto'),
});
export type EvolutionConfig = z.infer<typeof EvolutionConfig>;

export const CrawlConfig = z.object({
  maxDepth: z.number().min(0).max(10).default(2),
  maxPages: z.number().min(1).default(1000),
  concurrency: z.number().min(1).max(20).default(5),
  crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
  // Proxy configuration
  proxy: z
    .object({
      url: z.string().min(1, 'Proxy URL is required'),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  // Cookie injection (omits httpOnly/secure — those are CrawlOptions-level details)
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().default('/'),
      }),
    )
    .optional(),
});
export type CrawlConfig = z.infer<typeof CrawlConfig>;

export const SchemaConfig = z.object({
  mode: z.enum(['fixed', 'discovery', 'hybrid']),
  userFields: z.array(FieldDefinition).optional(),
  evolutionConfig: EvolutionConfig.optional(),
});
export type SchemaConfig = z.infer<typeof SchemaConfig>;

export const LLMModelOverrides = z.object({
  pageRelevance: z.string().optional(),
  extraction: z.string().optional(),
  linkEvaluation: z.string().optional(),
  schemaEvolution: z.string().optional(),
  entityMatching: z.string().optional(),
  conflictResolution: z.string().optional(),
  qualityAudit: z.string().optional(),
  documentation: z.string().optional(),
});
export type LLMModelOverrides = z.infer<typeof LLMModelOverrides>;

export const LLMConfig = z.object({
  primaryModel: z.string().default('anthropic/claude-sonnet-4-20250514'),
  modelOverrides: LLMModelOverrides.optional(),
});
export type LLMConfig = z.infer<typeof LLMConfig>;

export const EntityMatchStrategy = z.enum([
  'exact_name',
  'fuzzy_name',
  'composite_key',
  'llm_assisted',
]);
export type EntityMatchStrategy = z.infer<typeof EntityMatchStrategy>;

export const ConflictResolution = z.enum([
  'most_common',
  'most_complete',
  'source_priority',
  'most_recent',
  'llm_resolved',
]);
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const ReconciliationConfig = z.object({
  matchStrategy: EntityMatchStrategy.default('composite_key'),
  conflictResolution: ConflictResolution.default('most_complete'),
  sourcePriority: z.array(z.string()).optional(),
  fuzzyMatchThreshold: z.number().default(0.85),
  enableLLMMatching: z.boolean().default(true),
});
export type ReconciliationConfig = z.infer<typeof ReconciliationConfig>;

export const JobConfig = z.object({
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  seedUrls: z.array(z.string().url()),
  crawl: CrawlConfig.default({}),
  schema: SchemaConfig,
  llm: LLMConfig.default({}),
  reconciliation: ReconciliationConfig.optional(),
});
export type JobConfig = z.infer<typeof JobConfig>;

export const JobStatus = z.enum([
  'pending',
  'queued',
  'running',
  'paused',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;
