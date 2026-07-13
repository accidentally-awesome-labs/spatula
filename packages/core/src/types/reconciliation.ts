// Re-export shim: canonical types live in @spatula/core-types.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/reconciliation.ts`.
export { TrustLevel, SourceTrust, FieldProvenanceEntry, EntityMatch } from '@spatula/core-types';
