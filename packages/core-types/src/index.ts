/**
 * @spatula/core-types — type-only exports, zod schemas, and enums.
 *
 * Zero runtime dependencies (zod as peer). Frozen at v1; additive-only in 1.x.
 *
 * The Spatula monorepo ESLint rule blocks value-imports from this package via
 * `no-restricted-imports` with `allowTypeImports: true`. Consumers route
 * runtime value imports through `@spatula/shared` (legacy re-export shim) or
 * `@spatula/core` (zod schemas).
 */

// --- Errors ---
export { ErrorCode, STATUS_MAP } from './errors/codes.js';

// --- Enums ---
export { ActionType } from './enums/action-type.js';
export { JobStatus as JobStatusEnum } from './enums/job-status.js';
export { Scope } from './enums/scope.js';

// --- Schemas (zod + inferred types) ---
export {
  // Job configuration
  JobConfig,
  JobConfigSchema,
  JobStatus,
  // Job sub-configs
  CrawlConfig,
  SchemaConfig,
  EvolutionConfig,
  RelevanceThresholds,
  LLMConfig,
  LLMModelOverrides,
  ReconciliationConfig,
  WebhookConfig,
  WebhookEventType,
  EntityMatchStrategy,
  ConflictResolution,
} from './schemas/job.js';

export {
  // Fields
  FieldDefinition,
  FieldDefSchema,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from './schemas/field.js';
export type { FieldDef, FieldDefinitionInput, FieldDefinitionOutput } from './schemas/field.js';

export {
  // Actions
  PipelineAction,
  Action,
  ActionSchema,
  ActionSource,
  ActionStatus,
  SafetyPolicy,
} from './schemas/action.js';

export {
  // Extractions
  ExtractionResult,
  ExtractionResultSchema,
  ExtractionMetadata,
  UnmappedField,
  ValueProvenance,
  PageClassification,
  ExtractionStrategy,
} from './schemas/extraction.js';

export {
  // Normalization
  NormalizationRule,
} from './schemas/normalization.js';

export {
  // Reconciliation
  TrustLevel,
  SourceTrust,
  FieldProvenanceEntry,
  EntityMatch,
} from './schemas/reconciliation.js';
