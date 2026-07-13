// Re-export shim: canonical types live in @spatula/core-types.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/normalization.ts`.
export { NormalizationRule } from '@spatula/core-types';
