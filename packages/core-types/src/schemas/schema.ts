// Re-export the field-level types (FieldDefinition, FieldRelevance, FieldAlias,
// SchemaDefinition) under their legacy in-tree home. These live in
// `./field.ts` to support the plan-16-2 `FieldDef` alias surface; this module
// preserves the `@accidentally-awesome-labs/spatula-core/types/schema.js` import shape for back-compat.
export {
  FieldDefinition,
  FieldDefSchema,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from './field.js';
export type {
  FieldDefinition as FieldDefinitionType,
  FieldDefinitionInput,
  FieldDefinitionOutput,
  FieldDef,
  FieldRelevance as FieldRelevanceType,
  FieldAlias as FieldAliasType,
  SchemaDefinition as SchemaDefinitionType,
} from './field.js';
