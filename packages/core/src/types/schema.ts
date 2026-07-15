// Re-export shim: field-level types live in @accidentally-awesome-labs/spatula-core-types.
// Internal callers import from this path; the canonical source lives in
// `@accidentally-awesome-labs/spatula-core-types/src/schemas/field.ts`.
export {
  FieldDefinition,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from '@accidentally-awesome-labs/spatula-core-types';
export type {
  FieldDefinitionInput,
  FieldDefinitionOutput,
} from '@accidentally-awesome-labs/spatula-core-types';
