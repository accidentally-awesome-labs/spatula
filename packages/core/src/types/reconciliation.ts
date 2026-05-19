// Re-export shim: moved to @spatula/core-types in plan 16-2.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/reconciliation.ts`.
export { TrustLevel, SourceTrust, FieldProvenanceEntry, EntityMatch } from '@spatula/core-types';
