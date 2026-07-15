// Re-export shim: canonical types live in @accidentally-awesome-labs/spatula-core-types.
// Internal callers import from this path; the canonical source lives in
// `@accidentally-awesome-labs/spatula-core-types/src/schemas/reconciliation.ts`.
export {
  TrustLevel,
  SourceTrust,
  FieldProvenanceEntry,
  EntityMatch,
} from '@accidentally-awesome-labs/spatula-core-types';
