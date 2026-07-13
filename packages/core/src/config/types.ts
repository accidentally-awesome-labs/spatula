import { z } from 'zod';

/**
 * User-facing spatula.yaml schema.
 * Uses simplified field names (depth, limit, fields shorthand)
 * that get transformed to internal JobConfig format by the parser.
 */

// Field shorthand: "product_name: string" or expanded { field, type, ... }
// IMPORTANT: expanded form MUST come first in the union — z.union uses first-match.
// If z.record is first, { field: 'price', type: 'currency' } matches it as a
// two-key shorthand instead of an expanded entry.
export const YamlFieldShorthand = z.union([
  // Expanded form with all options (tried FIRST)
  z.object({
    field: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
    required: z.boolean().optional(),
    selector: z.string().optional(),
    description: z.string().optional(),
  }),
  // Shorthand: { product_name: "string" } → single key-value pair (tried second)
  z
    .record(
      z.string(),
      z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
    )
    .refine(
      (obj) => Object.keys(obj).length === 1,
      'Field shorthand must have exactly one key (e.g., "product_name: string")',
    ),
]);
export type YamlFieldShorthand = z.infer<typeof YamlFieldShorthand>;

export const SpatulaYamlSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),

    seeds: z.array(z.string().url()).min(1, 'At least one seed URL is required'),

    fields: z.array(YamlFieldShorthand).optional(),

    // Top-level shorthand for common options
    depth: z.number().min(0).max(10).optional(),
    limit: z.number().min(1).optional(),
    crawler: z.enum(['playwright', 'firecrawl']).optional(),
    safety: z.enum(['trust_ai', 'balanced', 'cautious', 'manual']).optional(),
    // Note: `safety` is NOT mapped to JobConfig (no safetyPreset field exists there).
    // It's a runtime setting consumed by the LocalPipelineRunner and action executor
    // Stored on ResolvedConfig for later use.

    // Nested config sections
    crawl: z
      .object({
        concurrency: z.number().min(1).max(20).optional(),
        proxy: z
          .union([
            z.string().min(1), // Bare string: "socks5://127.0.0.1:1080"
            z.object({
              // Object form with optional auth
              url: z.string().min(1),
              username: z.string().optional(),
              password: z.string().optional(),
            }),
          ])
          .optional()
          .transform((val) => {
            if (typeof val === 'string') return { url: val };
            return val;
          }),
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string(),
              path: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),

    schema: z
      .object({
        mode: z.enum(['fixed', 'discovery', 'hybrid']).optional(),
        evolution: z
          .object({
            batchSize: z.number().optional(),
            maxFields: z.number().optional(),
          })
          .optional(),
      })
      .optional(),

    llm: z
      .object({
        model: z.string().optional(),
        overrides: z
          .object({
            pageRelevance: z.string().optional(),
            extraction: z.string().optional(),
            linkEvaluation: z.string().optional(),
            schemaEvolution: z.string().optional(),
            entityMatching: z.string().optional(),
            conflictResolution: z.string().optional(),
            qualityAudit: z.string().optional(),
            documentation: z.string().optional(),
          })
          .optional(),
      })
      .optional(),

    reconciliation: z
      .object({
        strategy: z.enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted']).optional(),
        conflictResolution: z
          .enum(['most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved'])
          .optional(),
        fuzzyThreshold: z.number().optional(),
      })
      .optional(),

    export: z
      .object({
        format: z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']).optional(),
        autoExport: z.boolean().optional(),
        includeProvenance: z.boolean().optional(),
      })
      .optional(),

    // Note: notify is parsed and validated here but NOT mapped to JobConfig
    // (JobConfig has no notify field). It's consumed by the LocalPipelineRunner
    // Stored on SpatulaYaml for later use.
    notify: z
      .object({
        desktop: z.boolean().optional(),
        webhook: z.string().url().optional(),
        on: z.array(z.enum(['completed', 'failed', 'cancelled', 'action_pending'])).optional(),
      })
      .optional(),
  })
  .strict();

export type SpatulaYaml = z.infer<typeof SpatulaYamlSchema>;

/**
 * Global config at ~/.spatula/config.yaml
 */
export const GlobalConfigSchema = z
  .object({
    version: z.number().default(1),

    // Credentials
    openrouterApiKey: z.string().optional(),
    firecrawlApiKey: z.string().optional(),

    // LLM preferences
    llm: z
      .object({
        provider: z.enum(['openrouter', 'ollama']).optional(),
        model: z.string().optional(),
      })
      .optional(),

    // Crawler preference
    crawler: z.enum(['playwright', 'firecrawl']).optional(),

    // Politeness defaults
    politeness: z
      .object({
        respectRobotsTxt: z.boolean().optional(),
        delayMs: z.number().optional(),
      })
      .optional(),

    // Remote server connections
    remotes: z
      .record(
        z.string(),
        z.object({
          url: z.string().url(),
          apiKey: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough(); // passthrough (not strict) — preserve unknown keys for forward-compat
// Newer Spatula versions may add keys that older versions should ignore, not reject.

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * CLI flag overrides
 */
export interface CliFlags {
  depth?: number;
  limit?: number;
  crawler?: 'playwright' | 'firecrawl';
  model?: string;
  concurrency?: number;
}

/**
 * Fully resolved config — ready to convert to JobConfig
 */
export interface ResolvedConfig {
  projectYaml: SpatulaYaml;
  globalConfig: GlobalConfig | null;
  cliFlags: CliFlags;
  projectRoot: string;
}
