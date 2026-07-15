import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { PipelineAction } from '../types/actions.js';

const logger = createLogger('reconciliation-applier');

export interface ReconciliationDeps {
  entityRepo: {
    findById(
      entityId: string,
      tenantId: string,
    ): Promise<{
      id: string;
      mergedData: Record<string, unknown>;
      provenance: Record<string, unknown>;
    } | null>;
    updateMergedData(
      entityId: string,
      tenantId: string,
      changes: {
        mergedData?: Record<string, unknown>;
        provenance?: Record<string, unknown>;
      },
    ): Promise<unknown>;
  };
  entitySourceRepo: {
    bulkLink(
      links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
    ): Promise<unknown>;
  };
  sourceTrustRepo: {
    upsert(input: {
      jobId: string;
      tenantId: string;
      domain: string;
      trustLevel: string;
      reasoning: string;
    }): Promise<unknown>;
  };
}

export interface ReconciliationResult {
  applied: boolean;
  reason?: string;
  stateChanges?: Array<{ path: string; before: unknown; after: unknown }>;
}

export async function applyReconciliationAction(
  action: PipelineAction,
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  switch (action.type) {
    case 'resolve_conflict':
      return applyResolveConflict(action, tenantId, deps);
    case 'infer_value':
      return applyInferValue(action, tenantId, deps);
    case 'correct_value':
      return applyCorrectValue(action, tenantId, deps);
    case 'match_entities':
      return applyMatchEntities(action, tenantId, deps);
    case 'split_entities':
      return applySplitEntities(action);
    case 'set_source_trust':
      return applySetSourceTrust(action, tenantId, deps);
    default:
      return {
        applied: false,
        reason: `Not a reconciliation action: ${(action as PipelineAction).type}`,
      };
  }
}

async function applyResolveConflict(
  action: PipelineAction & { type: 'resolve_conflict' },
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const { entityId, fieldName, resolvedValue, sourcePreferred, allValues } = action.payload;

  const entity = await deps.entityRepo.findById(entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${entityId} not found` };
  }

  const before = entity.mergedData[fieldName];
  const newMergedData = { ...entity.mergedData, [fieldName]: resolvedValue };
  const newProvenance = {
    ...entity.provenance,
    [fieldName]: {
      finalValue: resolvedValue,
      provenanceType: 'merged',
      sources: allValues.map((v) => v.source),
      hadConflict: true,
      sourcePreferred,
    },
  };

  await deps.entityRepo.updateMergedData(entityId, tenantId, {
    mergedData: newMergedData,
    provenance: newProvenance,
  });

  logger.debug({ entityId, fieldName, resolvedValue }, 'conflict resolved');

  return {
    applied: true,
    stateChanges: [{ path: `mergedData.${fieldName}`, before, after: resolvedValue }],
  };
}

async function applyInferValue(
  action: PipelineAction & { type: 'infer_value' },
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const { entityId, fieldName, inferredValue, inferredFrom } = action.payload;

  const entity = await deps.entityRepo.findById(entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${entityId} not found` };
  }

  const before = entity.mergedData[fieldName];
  const newMergedData = { ...entity.mergedData, [fieldName]: inferredValue };
  const newProvenance = {
    ...entity.provenance,
    [fieldName]: {
      finalValue: inferredValue,
      provenanceType: 'inferred',
      sources: [],
      hadConflict: false,
      inferredFrom,
    },
  };

  await deps.entityRepo.updateMergedData(entityId, tenantId, {
    mergedData: newMergedData,
    provenance: newProvenance,
  });

  logger.debug({ entityId, fieldName, inferredValue }, 'value inferred');

  return {
    applied: true,
    stateChanges: [{ path: `mergedData.${fieldName}`, before, after: inferredValue }],
  };
}

async function applyCorrectValue(
  action: PipelineAction & { type: 'correct_value' },
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const { entityId, fieldName, currentValue, correctedValue, correctionType } = action.payload;

  const entity = await deps.entityRepo.findById(entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${entityId} not found` };
  }

  const before = entity.mergedData[fieldName];
  const newMergedData = { ...entity.mergedData, [fieldName]: correctedValue };
  const newProvenance = {
    ...entity.provenance,
    [fieldName]: {
      finalValue: correctedValue,
      provenanceType: 'normalized',
      sources: [correctionType],
      hadConflict: false,
      correctedFrom: currentValue,
      correctionType,
    },
  };

  await deps.entityRepo.updateMergedData(entityId, tenantId, {
    mergedData: newMergedData,
    provenance: newProvenance,
  });

  logger.debug({ entityId, fieldName, correctedValue, correctionType }, 'value corrected');

  return {
    applied: true,
    stateChanges: [{ path: `mergedData.${fieldName}`, before, after: correctedValue }],
  };
}

async function applyMatchEntities(
  action: PipelineAction & { type: 'match_entities' },
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const { entityId, extractionIds } = action.payload;

  const entity = await deps.entityRepo.findById(entityId, tenantId);
  if (!entity) {
    return { applied: false, reason: `Entity ${entityId} not found` };
  }

  const links = extractionIds.map((extractionId) => ({
    entityId,
    extractionId,
    matchConfidence: action.confidence,
  }));

  await deps.entitySourceRepo.bulkLink(links);

  logger.debug({ entityId, count: extractionIds.length }, 'extractions linked to entity');

  return { applied: true };
}

function applySplitEntities(
  action: PipelineAction & { type: 'split_entities' },
): ReconciliationResult {
  logger.warn(
    { entityId: action.payload.entityId },
    'split_entities called but not yet implemented',
  );
  return { applied: false, reason: 'split_entities not yet implemented' };
}

async function applySetSourceTrust(
  action: PipelineAction & { type: 'set_source_trust' },
  tenantId: string,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const { rankings } = action.payload;

  for (const ranking of rankings) {
    await deps.sourceTrustRepo.upsert({
      jobId: action.jobId,
      tenantId,
      domain: ranking.domain,
      trustLevel: ranking.trustLevel,
      reasoning: ranking.reasoning,
    });
  }

  logger.debug({ count: rankings.length }, 'source trust rankings upserted');

  return { applied: true };
}
