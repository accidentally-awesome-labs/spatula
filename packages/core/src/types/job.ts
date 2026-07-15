// Re-export shim: canonical types live in @accidentally-awesome-labs/spatula-core-types.
// Internal callers import from this path; the canonical source lives in
// `@accidentally-awesome-labs/spatula-core-types/src/schemas/job.ts`.
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
} from '@accidentally-awesome-labs/spatula-core-types';
