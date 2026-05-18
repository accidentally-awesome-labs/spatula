import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyReconciliationAction,
  type ReconciliationDeps,
} from '../../../src/execution/reconciliation-applier.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(): Pick<
  PipelineAction,
  'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'
> {
  return {
    id: generateId(),
    jobId: generateId(),
    source: 'reconciliation',
    reasoning: 'test',
    confidence: 0.9,
  };
}

function createMockDeps(): ReconciliationDeps {
  return {
    entityRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'entity-1',
        tenantId: 'tenant-1',
        mergedData: { name: 'Widget', price: 10 },
        provenance: {
          name: {
            finalValue: 'Widget',
            provenanceType: 'extracted',
            sources: [],
            hadConflict: false,
          },
        },
      }),
      updateMergedData: vi
        .fn()
        .mockImplementation((_id, _tid, changes) =>
          Promise.resolve({ id: 'entity-1', ...changes }),
        ),
    } as any,
    entitySourceRepo: {
      link: vi.fn().mockResolvedValue({ entityId: 'entity-1', extractionId: 'ext-1' }),
      bulkLink: vi.fn().mockResolvedValue([]),
      findByEntity: vi.fn().mockResolvedValue([]),
    } as any,
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'st-1' }),
    } as any,
  };
}

describe('applyReconciliationAction', () => {
  let deps: ReconciliationDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolve_conflict updates entity field value and provenance', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'resolve_conflict',
      payload: {
        entityId: 'entity-1',
        fieldName: 'name',
        resolvedValue: 'Super Widget',
        sourcePreferred: 'source-a.com',
        allValues: [
          { source: 'source-a.com', value: 'Super Widget' },
          { source: 'source-b.com', value: 'Widget' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.findById).toHaveBeenCalledWith('entity-1', 'tenant-1');
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ name: 'Super Widget' }),
      }),
    );
  });

  it('infer_value adds a new field with inferred provenance', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'infer_value',
      payload: {
        entityId: 'entity-1',
        fieldName: 'category',
        inferredValue: 'electronics',
        inferredFrom: 'product name and price patterns',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ category: 'electronics' }),
      }),
    );
  });

  it('correct_value overwrites field with correction', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'correct_value',
      payload: {
        entityId: 'entity-1',
        fieldName: 'price',
        currentValue: 10,
        correctedValue: 9.99,
        correctionType: 'format_fix',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entityRepo.updateMergedData).toHaveBeenCalledWith(
      'entity-1',
      'tenant-1',
      expect.objectContaining({
        mergedData: expect.objectContaining({ price: 9.99 }),
      }),
    );
  });

  it('match_entities links additional extractions to an entity', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'match_entities',
      payload: {
        entityId: 'entity-1',
        extractionIds: ['ext-1', 'ext-2'],
        matchedOn: ['name', 'brand'],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.entitySourceRepo.bulkLink).toHaveBeenCalledWith([
      { entityId: 'entity-1', extractionId: 'ext-1', matchConfidence: 0.9 },
      { entityId: 'entity-1', extractionId: 'ext-2', matchConfidence: 0.9 },
    ]);
  });

  it('set_source_trust upserts trust rankings', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'set_source_trust',
      payload: {
        rankings: [
          { domain: 'trusted.com', trustLevel: 'high', reasoning: 'Reliable source' },
          { domain: 'sketchy.com', trustLevel: 'low', reasoning: 'Often inaccurate' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.sourceTrustRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it('split_entities returns applied=false (not implemented in v1)', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'split_entities',
      payload: {
        entityId: 'entity-1',
        newGroups: [
          { extractionIds: ['ext-1'], reasoning: 'group A' },
          { extractionIds: ['ext-2'], reasoning: 'group B' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not yet implemented');
  });

  it('returns applied=false for entity not found', async () => {
    (deps.entityRepo.findById as any).mockResolvedValue(null);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'resolve_conflict',
      payload: {
        entityId: 'missing',
        fieldName: 'name',
        resolvedValue: 'x',
        sourcePreferred: 'a.com',
        allValues: [{ source: 'a.com', value: 'x' }],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('returns applied=false for unsupported action type', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'add_field',
      payload: {
        field: { name: 'x', description: 'x', type: 'string', required: false },
        relevance: {
          globalFrequency: 0.5,
          categoryBreakdown: [],
          classification: 'universal_optional',
          applicableCategories: null,
        },
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
  });

  it('infer_value returns applied=false when entity not found', async () => {
    (deps.entityRepo.findById as any).mockResolvedValue(null);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'infer_value',
      payload: {
        entityId: 'missing-entity',
        fieldName: 'category',
        inferredValue: 'electronics',
        inferredFrom: 'name patterns',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('correct_value returns applied=false when entity not found', async () => {
    (deps.entityRepo.findById as any).mockResolvedValue(null);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'correct_value',
      payload: {
        entityId: 'missing-entity',
        fieldName: 'price',
        currentValue: 10,
        correctedValue: 9.99,
        correctionType: 'format_fix',
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('match_entities returns applied=false when entity not found', async () => {
    (deps.entityRepo.findById as any).mockResolvedValue(null);

    const action: PipelineAction = {
      ...baseAction(),
      type: 'match_entities',
      payload: {
        entityId: 'missing-entity',
        extractionIds: ['ext-1', 'ext-2'],
        matchedOn: ['name'],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('resolve_conflict stateChanges has correct path, before, and after', async () => {
    const action: PipelineAction = {
      ...baseAction(),
      type: 'resolve_conflict',
      payload: {
        entityId: 'entity-1',
        fieldName: 'name',
        resolvedValue: 'Super Widget',
        sourcePreferred: 'source-a.com',
        allValues: [
          { source: 'source-a.com', value: 'Super Widget' },
          { source: 'source-b.com', value: 'Widget' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(result.stateChanges).toBeDefined();
    expect(result.stateChanges).toHaveLength(1);
    expect(result.stateChanges![0].path).toBe('mergedData.name');
    expect(result.stateChanges![0].before).toBe('Widget');
    expect(result.stateChanges![0].after).toBe('Super Widget');
  });

  it('set_source_trust upsert calls have correct arguments', async () => {
    const base = baseAction();
    const action: PipelineAction = {
      ...base,
      type: 'set_source_trust',
      payload: {
        rankings: [
          { domain: 'trusted.com', trustLevel: 'high', reasoning: 'Reliable source' },
          { domain: 'sketchy.com', trustLevel: 'low', reasoning: 'Often inaccurate' },
        ],
      },
    };

    const result = await applyReconciliationAction(action, 'tenant-1', deps);

    expect(result.applied).toBe(true);
    expect(deps.sourceTrustRepo.upsert).toHaveBeenCalledTimes(2);
    expect(deps.sourceTrustRepo.upsert).toHaveBeenNthCalledWith(1, {
      domain: 'trusted.com',
      trustLevel: 'high',
      reasoning: 'Reliable source',
      jobId: base.jobId,
      tenantId: 'tenant-1',
    });
    expect(deps.sourceTrustRepo.upsert).toHaveBeenNthCalledWith(2, {
      domain: 'sketchy.com',
      trustLevel: 'low',
      reasoning: 'Often inaccurate',
      jobId: base.jobId,
      tenantId: 'tenant-1',
    });
  });
});
