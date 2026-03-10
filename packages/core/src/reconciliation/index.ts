export { applyNormalizationRule, normalizeExtractionData } from './value-normalizer.js';
export type { NormalizationChange, NormalizedResult } from './value-normalizer.js';
export {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  matchEntitiesFuzzy,
  matchEntitiesLLM,
  levenshteinSimilarity,
  normalizeKeyValue,
} from './entity-matcher.js';
export type { ExtractionWithSource } from './entity-matcher.js';
export { SourceTrustEvaluator } from './source-trust-evaluator.js';
export { resolveConflict } from './conflict-resolver.js';
export type {
  FieldConflict,
  FieldConflictValue,
  ResolvedField,
  ConflictResolverOptions,
} from './conflict-resolver.js';
export { GapFiller } from './gap-filler.js';
export { DataReconcilerImpl } from './data-reconciler-impl.js';
