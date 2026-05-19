// Re-export shim: field-level types moved to @spatula/core-types in plan 16-2.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/field.ts`.
export {
  FieldDefinition,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from '@spatula/core-types';
export type { FieldDefinitionInput, FieldDefinitionOutput } from '@spatula/core-types';
