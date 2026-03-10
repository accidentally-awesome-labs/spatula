import { createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig, ReconciliationConfig } from '../types/job.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { EntityMatch, FieldProvenanceEntry, SourceTrust } from '../types/reconciliation.js';
import type { PipelineAction } from '../types/actions.js';
import type { DataReconciler } from '../interfaces/reconciler.js';
import type { ExtractionWithSource } from './entity-matcher.js';
import { normalizeExtractionData, type NormalizationChange } from './value-normalizer.js';
import {
  matchEntitiesExact,
  matchEntitiesCompositeKey,
  matchEntitiesFuzzy,
  matchEntitiesLLM,
} from './entity-matcher.js';
import { SourceTrustEvaluator } from './source-trust-evaluator.js';
import {
  resolveConflict,
  type FieldConflict,
  type FieldConflictValue,
} from './conflict-resolver.js';
import { GapFiller } from './gap-filler.js';

const logger = createLogger('data-reconciler');

/**
 * Full pipeline orchestrator for data reconciliation.
 *
 * Combines value normalization, entity matching, source trust evaluation,
 * conflict resolution, and gap filling into a single coherent pipeline.
 */
export class DataReconcilerImpl implements DataReconciler {
  private readonly sourceTrustEvaluator: SourceTrustEvaluator;
  private readonly gapFiller: GapFiller;

  constructor(
    private readonly llmClient: LLMClient,
    private readonly llmConfig: LLMConfig,
  ) {
    this.sourceTrustEvaluator = new SourceTrustEvaluator(llmClient, llmConfig);
    this.gapFiller = new GapFiller(llmClient, llmConfig);
  }

  async reconcile(
    extractions: ExtractionWithSource[],
    schema: SchemaDefinition,
    config: ReconciliationConfig,
    jobDescription: string,
  ): Promise<{
    entities: EntityMatch[];
    actions: PipelineAction[];
  }> {
    if (extractions.length === 0) {
      return { entities: [], actions: [] };
    }

    const allActions: PipelineAction[] = [];

    // -----------------------------------------------------------------------
    // Step 1: Normalize all extraction data
    // -----------------------------------------------------------------------

    // Track original data for provenance before normalization
    const originalDataMap = new Map<string, Record<string, unknown>>();
    const changeMap = new Map<string, NormalizationChange[]>();

    const normalizedExtractions: ExtractionWithSource[] = extractions.map((ext) => {
      originalDataMap.set(ext.id, { ...ext.data });
      const { normalizedData, changes } = normalizeExtractionData(ext.data, schema);
      changeMap.set(ext.id, changes);
      return { ...ext, data: normalizedData };
    });

    logger.debug(
      {
        extractionCount: extractions.length,
        normalizedCount: normalizedExtractions.filter(
          (ext) => (changeMap.get(ext.id)?.length ?? 0) > 0,
        ).length,
      },
      'normalization step complete',
    );

    // -----------------------------------------------------------------------
    // Step 2: Evaluate source trust
    // -----------------------------------------------------------------------

    const uniqueDomains = [...new Set(normalizedExtractions.map((e) => e.sourceDomain))];

    let trustActions: PipelineAction[];
    if (config.sourcePriority && config.sourcePriority.length > 0) {
      trustActions = this.sourceTrustEvaluator.evaluateWithPriority(
        uniqueDomains,
        config.sourcePriority,
      );
    } else {
      trustActions = await this.sourceTrustEvaluator.evaluate(uniqueDomains, jobDescription);
    }
    allActions.push(...trustActions);

    // Extract trust rankings for conflict resolution
    const trustRankings: SourceTrust[] = [];
    for (const action of trustActions) {
      if (action.type === 'set_source_trust') {
        const rankings = action.payload.rankings as SourceTrust[];
        trustRankings.push(...rankings);
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Match entities
    // -----------------------------------------------------------------------

    const keyFields = schema.fields.filter((f) => f.required === true).map((f) => f.name);

    if (keyFields.length === 0) {
      logger.warn('no required fields in schema — each extraction becomes its own entity');
    }

    let entityGroups: ExtractionWithSource[][];

    switch (config.matchStrategy) {
      case 'exact_name':
        entityGroups = matchEntitiesExact(normalizedExtractions, keyFields);
        break;
      case 'fuzzy_name':
        entityGroups = matchEntitiesFuzzy(
          normalizedExtractions,
          keyFields,
          config.fuzzyMatchThreshold,
        );
        break;
      case 'composite_key':
        entityGroups = matchEntitiesCompositeKey(
          normalizedExtractions,
          keyFields,
          config.fuzzyMatchThreshold,
        );
        break;
      case 'llm_assisted':
        entityGroups = await matchEntitiesLLM(
          normalizedExtractions,
          this.llmClient,
          this.llmConfig,
        );
        break;
      default:
        entityGroups = matchEntitiesExact(normalizedExtractions, keyFields);
        break;
    }

    logger.debug(
      { groupCount: entityGroups.length, strategy: config.matchStrategy },
      'entity matching step complete',
    );

    // -----------------------------------------------------------------------
    // Step 4: For each entity group, merge data and resolve conflicts
    // -----------------------------------------------------------------------

    const entities: EntityMatch[] = [];

    for (const group of entityGroups) {
      const entityId = generateId();

      // Record match_entities action (worker stamps correct jobId afterward)
      const matchAction: PipelineAction = {
        id: generateId(),
        jobId: generateId(),
        type: 'match_entities',
        source: 'reconciliation',
        reasoning: `Matched ${group.length} extraction(s) using ${config.matchStrategy} strategy`,
        confidence: 1,
        payload: {
          entityId,
          extractionIds: group.map((e) => e.id),
          matchedOn: keyFields,
        },
      };
      allActions.push(matchAction);

      // Build sourceExtractions
      const sourceExtractions = group.map((ext) => ({
        extractionId: ext.id,
        sourceUrl: ext.sourceUrl,
        sourceDomain: ext.sourceDomain,
        crawledAt: ext.crawledAt,
        fieldsCovered: Object.keys(ext.data).filter(
          (k) => ext.data[k] !== null && ext.data[k] !== undefined,
        ),
      }));

      // Collect all field names across all extractions in the group
      const allFieldNames = new Set<string>();
      for (const ext of group) {
        for (const key of Object.keys(ext.data)) {
          if (ext.data[key] !== null && ext.data[key] !== undefined) {
            allFieldNames.add(key);
          }
        }
      }

      // Merge data and build provenance
      const mergedData: Record<string, unknown> = {};
      const fieldProvenance: Record<string, FieldProvenanceEntry> = {};

      for (const fieldName of allFieldNames) {
        // Collect all values for this field across extractions
        const fieldValues: FieldConflictValue[] = [];
        for (const ext of group) {
          const value = ext.data[fieldName];
          if (value !== null && value !== undefined) {
            fieldValues.push({
              source: ext.sourceDomain,
              value,
              extractionId: ext.id,
              crawledAt: ext.crawledAt,
            });
          }
        }

        if (fieldValues.length === 0) {
          continue;
        }

        // Build the conflict and resolve
        const conflict: FieldConflict = {
          fieldName,
          values: fieldValues,
        };

        const resolved = resolveConflict(conflict, config.conflictResolution, {
          trustRankings,
        });

        mergedData[fieldName] = resolved.resolvedValue;

        // Record resolve_conflict action if there was a true conflict
        if (resolved.hadConflict) {
          const conflictAction: PipelineAction = {
            id: generateId(),
            jobId: generateId(),
            type: 'resolve_conflict',
            source: 'reconciliation',
            reasoning: `Resolved conflict for field "${fieldName}" using ${config.conflictResolution} strategy`,
            confidence: 1,
            payload: {
              entityId,
              fieldName,
              resolvedValue: resolved.resolvedValue,
              sourcePreferred: resolved.sourcePreferred,
              allValues: fieldValues.map((v) => ({
                source: v.source,
                value: v.value,
              })),
            },
          };
          allActions.push(conflictAction);
        }

        // Determine provenance type
        const wasNormalized = group.some((ext) => {
          const changes = changeMap.get(ext.id) ?? [];
          return changes.some((c) => c.fieldName === fieldName);
        });

        let provenanceType: 'extracted' | 'normalized' | 'merged' | 'resolved';
        if (resolved.hadConflict) {
          provenanceType = 'resolved';
        } else if (wasNormalized) {
          provenanceType = 'normalized';
        } else if (fieldValues.length > 1) {
          provenanceType = 'merged';
        } else {
          provenanceType = 'extracted';
        }

        // Build source provenance entries
        const sources = group
          .filter((ext) => ext.data[fieldName] !== null && ext.data[fieldName] !== undefined)
          .map((ext) => {
            const originalData = originalDataMap.get(ext.id) ?? {};
            return {
              sourceUrl: ext.sourceUrl,
              rawValue: originalData[fieldName] ?? ext.data[fieldName],
              normalizedValue: ext.data[fieldName],
            };
          });

        fieldProvenance[fieldName] = {
          finalValue: resolved.resolvedValue,
          provenanceType,
          sources,
          hadConflict: resolved.hadConflict,
          resolution: resolved.hadConflict ? resolved.resolution : undefined,
        };
      }

      entities.push({
        entityId,
        sourceExtractions,
        mergedData,
        fieldProvenance,
      });
    }

    logger.debug(
      { entityCount: entities.length },
      'entity merge and conflict resolution step complete',
    );

    // -----------------------------------------------------------------------
    // Step 5: Fill gaps
    // -----------------------------------------------------------------------

    for (const entity of entities) {
      const gapActions = await this.gapFiller.fillGaps(
        entity.entityId,
        entity.mergedData,
        schema,
        jobDescription,
      );

      // Apply inferred values to entity
      for (const action of gapActions) {
        if (action.type === 'infer_value') {
          const { fieldName, inferredValue } = action.payload;
          entity.mergedData[fieldName] = inferredValue;
          entity.fieldProvenance[fieldName] = {
            finalValue: inferredValue,
            provenanceType: 'inferred',
            sources: [],
            hadConflict: false,
          };
        }
      }

      allActions.push(...gapActions);
    }

    logger.info(
      {
        entityCount: entities.length,
        actionCount: allActions.length,
        extractionCount: extractions.length,
      },
      'data reconciliation pipeline complete',
    );

    return { entities, actions: allActions };
  }
}
