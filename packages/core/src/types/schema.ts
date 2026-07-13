// Re-export shim: field-level types live in @spatula/core-types.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/field.ts`.
export { FieldDefinition, FieldRelevance, FieldAlias, SchemaDefinition } from '@spatula/core-types';
export type { FieldDefinitionInput, FieldDefinitionOutput } from '@spatula/core-types';
