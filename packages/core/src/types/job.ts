// Re-export shim: moved to @spatula/core-types in plan 16-2.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/job.ts`.
export {
  RelevanceThresholds,
  EvolutionConfig,
  CrawlConfig,
  SchemaConfig,
  LLMModelOverrides,
  LLMConfig,
  EntityMatchStrategy,
  ConflictResolution,
  ReconciliationConfig,
  JobConfig,
  JobStatus,
} from '@spatula/core-types';
