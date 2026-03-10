import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';
import type { SchemaDefinition, FieldDefinition, FieldAlias } from '../types/schema.js';

const logger = createLogger('schema-action-applier');

/**
 * Pure function that applies an array of PipelineActions to a SchemaDefinition,
 * producing a new SchemaDefinition. This is a state reducer with no side effects.
 *
 * Only schema-related action types are applied; all others are silently skipped.
 * If no actions are applied, the schema is returned unchanged (same version).
 */
export function applySchemaActions(
  schema: SchemaDefinition,
  actions: PipelineAction[],
): SchemaDefinition {
  if (actions.length === 0) {
    return schema;
  }

  let fields: FieldDefinition[] = structuredClone(schema.fields);
  let fieldAliases: FieldAlias[] = structuredClone(schema.fieldAliases);
  let applied = 0;

  for (const action of actions) {
    switch (action.type) {
      case 'add_field': {
        const existing = fields.find(
          (f) => f.name === action.payload.field.name,
        );
        if (existing) {
          logger.debug(
            { fieldName: action.payload.field.name },
            'Skipping add_field: field already exists',
          );
          break;
        }

        if (action.payload.insertAfter) {
          const idx = fields.findIndex(
            (f) => f.name === action.payload.insertAfter,
          );
          if (idx !== -1) {
            fields.splice(idx + 1, 0, structuredClone(action.payload.field));
          } else {
            fields.push(structuredClone(action.payload.field));
          }
        } else {
          fields.push(structuredClone(action.payload.field));
        }
        applied++;
        break;
      }

      case 'remove_field': {
        const idx = fields.findIndex(
          (f) => f.name === action.payload.fieldName,
        );
        if (idx === -1) {
          logger.debug(
            { fieldName: action.payload.fieldName },
            'Skipping remove_field: field not found',
          );
          break;
        }
        fields.splice(idx, 1);
        applied++;
        break;
      }

      case 'modify_field': {
        const field = fields.find(
          (f) => f.name === action.payload.fieldName,
        );
        if (!field) {
          logger.debug(
            { fieldName: action.payload.fieldName },
            'Skipping modify_field: field not found',
          );
          break;
        }
        const { changes } = action.payload;
        if (changes.type !== undefined) {
          field.type = changes.type;
        }
        if (changes.required !== undefined) {
          field.required = changes.required;
        }
        if (changes.description !== undefined) {
          field.description = changes.description;
        }
        if (changes.enumValues !== undefined) {
          field.enumValues = [...changes.enumValues];
        }
        applied++;
        break;
      }

      case 'rename_field': {
        const field = fields.find(
          (f) => f.name === action.payload.currentName,
        );
        if (!field) {
          logger.debug(
            { currentName: action.payload.currentName },
            'Skipping rename_field: field not found',
          );
          break;
        }
        field.name = action.payload.newName;
        applied++;
        break;
      }

      case 'merge_fields': {
        const { canonicalName, aliasNames, canonicalDefinition, valueMappings } =
          action.payload;

        // Remove alias fields from the fields array
        fields = fields.filter((f) => !aliasNames.includes(f.name));

        // Add the canonical definition if it doesn't already exist
        const existingCanonical = fields.find((f) => f.name === canonicalName);
        if (!existingCanonical) {
          fields.push(structuredClone(canonicalDefinition));
        }

        // Record the FieldAlias
        const alias: FieldAlias = {
          canonicalName,
          aliases: aliasNames.map((name) => ({
            name,
            sources: [],
            occurrences: 0,
          })),
          mergedAt: new Date(),
          reasoning: action.reasoning,
        };
        fieldAliases.push(alias);
        applied++;
        break;
      }

      case 'set_normalization_rule': {
        const field = fields.find(
          (f) => f.name === action.payload.fieldName,
        );
        if (!field) {
          logger.debug(
            { fieldName: action.payload.fieldName },
            'Skipping set_normalization_rule: field not found',
          );
          break;
        }
        field.normalization = structuredClone(action.payload.rule);
        applied++;
        break;
      }

      case 'update_enum_map': {
        const field = fields.find(
          (f) => f.name === action.payload.fieldName,
        );
        if (!field) {
          logger.debug(
            { fieldName: action.payload.fieldName },
            'Skipping update_enum_map: field not found',
          );
          break;
        }

        // Ensure the field has an enum normalization rule
        if (field.normalization?.type === 'enum') {
          // Merge additions into the synonym map
          const currentMap = field.normalization.config.synonymMap;
          for (const [key, value] of Object.entries(
            action.payload.additions,
          )) {
            currentMap[key] = value;
          }

          // Add new canonical values if specified
          if (action.payload.newCanonicalValues) {
            const existing = new Set(
              field.normalization.config.canonicalValues,
            );
            for (const v of action.payload.newCanonicalValues) {
              if (!existing.has(v)) {
                field.normalization.config.canonicalValues.push(v);
              }
            }
          }
        } else {
          logger.debug(
            { fieldName: action.payload.fieldName },
            'Skipping update_enum_map: field does not have enum normalization',
          );
          break;
        }
        applied++;
        break;
      }

      default: {
        logger.debug(
          { type: (action as PipelineAction).type },
          'Skipping unsupported action type',
        );
        break;
      }
    }
  }

  if (applied === 0) {
    return schema;
  }

  return {
    version: schema.version + 1,
    parentVersion: schema.version,
    fields,
    fieldAliases,
    createdAt: new Date(),
  };
}
