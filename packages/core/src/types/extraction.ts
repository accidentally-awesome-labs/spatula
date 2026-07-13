// Re-export shim: canonical types live in @spatula/core-types.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/extraction.ts`.
export {
  UnmappedField,
  ExtractionMetadata,
  ExtractionResult,
  ValueProvenance,
  PageClassification,
  ExtractionStrategy,
} from '@spatula/core-types';
