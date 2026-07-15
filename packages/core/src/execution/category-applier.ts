import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { PipelineAction } from '../types/actions.js';
import type { SchemaDefinition } from '../types/schema.js';

const logger = createLogger('category-applier');

export interface CategoryDefinition {
  name: string;
  description: string;
  matchCriteria: string;
}

export interface CategoryMetadata {
  categoryField: string;
  definitions: CategoryDefinition[];
}

export interface CategoryFieldAssignment {
  requiredFields: string[];
  optionalFields: string[];
}

export interface CategoryApplierResult {
  categories?: CategoryMetadata;
  categoryFieldAssignments?: Record<string, CategoryFieldAssignment>;
}

export function applyCategoryActions(
  schema: SchemaDefinition,
  actions: PipelineAction[],
): CategoryApplierResult {
  let categories: CategoryMetadata | undefined;
  let assignments: Record<string, CategoryFieldAssignment> | undefined;

  for (const action of actions) {
    switch (action.type) {
      case 'define_category': {
        categories = {
          categoryField: action.payload.categoryField,
          definitions: action.payload.categories.map((c) => ({
            name: c.name,
            description: c.description,
            matchCriteria: c.matchCriteria,
          })),
        };
        logger.debug(
          { categoryField: action.payload.categoryField, count: action.payload.categories.length },
          'categories defined',
        );
        break;
      }

      case 'assign_category_fields': {
        if (!assignments) assignments = {};
        assignments[action.payload.category] = {
          requiredFields: [...action.payload.requiredFields],
          optionalFields: [...action.payload.optionalFields],
        };
        logger.debug({ category: action.payload.category }, 'category fields assigned');
        break;
      }

      default:
        break;
    }
  }

  return {
    ...(categories ? { categories } : {}),
    ...(assignments ? { categoryFieldAssignments: assignments } : {}),
  };
}
