import { createLogger } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';

const logger = createLogger('finalization-applier');

export interface FinalizationMetadata {
  tableStructure?: {
    strategy: string;
    tables: Array<{
      name: string;
      description: string;
      fields: string[];
      relationship?: string;
      foreignKey?: string;
    }>;
  };
  derivedField?: {
    fieldName: string;
    derivedFrom: string[];
    derivationLogic: string;
  };
  anomaly?: {
    entityId?: string;
    fieldName?: string;
    anomalyType: string;
    description: string;
    suggestedFix?: unknown;
  };
  documentation?: {
    dataDictionary: unknown[];
    categoryBreakdown: unknown[];
    qualitySummary: unknown;
  };
}

export interface FinalizationResult {
  applied: boolean;
  reason?: string;
  metadata?: FinalizationMetadata;
}

export function applyFinalizationAction(action: PipelineAction): FinalizationResult {
  switch (action.type) {
    case 'recommend_table_structure': {
      logger.debug({ strategy: action.payload.strategy }, 'table structure recommendation');
      return {
        applied: true,
        metadata: {
          tableStructure: {
            strategy: action.payload.strategy,
            tables: action.payload.tables.map((t) => ({
              name: t.name,
              description: t.description,
              fields: [...t.fields],
              ...(t.relationship ? { relationship: t.relationship } : {}),
              ...(t.foreignKey ? { foreignKey: t.foreignKey } : {}),
            })),
          },
        },
      };
    }

    case 'derive_field': {
      logger.debug({ fieldName: action.payload.fieldName }, 'derived field recorded');
      return {
        applied: true,
        metadata: {
          derivedField: {
            fieldName: action.payload.fieldName,
            derivedFrom: [...action.payload.derivedFrom],
            derivationLogic: action.payload.derivationLogic,
          },
        },
      };
    }

    case 'flag_anomaly': {
      logger.debug({ anomalyType: action.payload.anomalyType }, 'anomaly flagged');
      return {
        applied: true,
        metadata: {
          anomaly: {
            entityId: action.payload.entityId,
            fieldName: action.payload.fieldName,
            anomalyType: action.payload.anomalyType,
            description: action.payload.description,
            suggestedFix: action.payload.suggestedFix,
          },
        },
      };
    }

    case 'generate_documentation': {
      logger.debug('documentation generation recorded');
      return {
        applied: true,
        metadata: {
          documentation: {
            dataDictionary: action.payload.dataDictionary,
            categoryBreakdown: action.payload.categoryBreakdown,
            qualitySummary: action.payload.qualitySummary,
          },
        },
      };
    }

    default:
      return { applied: false, reason: `Not a finalization action: ${action.type}` };
  }
}
