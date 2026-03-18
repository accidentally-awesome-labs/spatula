import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultActionExecutor } from '../../../src/execution/action-executor-impl.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import { generateId } from '@spatula/shared';

function baseAction(
  overrides: Partial<PipelineAction> = {},
): Pick<PipelineAction, 'id' | 'jobId' | 'source' | 'reasoning' | 'confidence'> {
  return {
    id: generateId(),
    jobId: 'job-1',
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.9,
    ...overrides,
  };
}

function createMockDeps() {
  return {
    actionRepo: {
      create: vi.fn().mockResolvedValue({ id: 'action-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue({ id: 'action-1' }),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', description: 'Title', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
      create: vi.fn().mockResolvedValue({ id: 'schema-2' }),
    },
    entityRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'entity-1',
        mergedData: { name: 'Widget' },
        provenance: {},
      }),
      updateMergedData: vi.fn().mockResolvedValue({ id: 'entity-1' }),
    },
    entitySourceRepo: {
      bulkLink: vi.fn().mockResolvedValue([]),
    },
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'st-1' }),
    },
    reviewQueue: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      getPending: vi.fn().mockResolvedValue([]),
      approve: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      approveAll: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('DefaultActionExecutor', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let executor: DefaultActionExecutor;

  beforeEach(() => {
    deps = createMockDeps();
    executor = new DefaultActionExecutor({
      actionRepo: deps.actionRepo as any,
      schemaRepo: deps.schemaRepo as any,
      entityRepo: deps.entityRepo as any,
      entitySourceRepo: deps.entitySourceRepo as any,
      sourceTrustRepo: deps.sourceTrustRepo as any,
      reviewQueue: deps.reviewQueue as any,
      approvalPreset: 'balanced',
      confidenceThreshold: 0.7,
      tenantId: 'tenant-1',
    });
  });

  describe('execute', () => {
    it('auto-applies always_auto action (classify_page)', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.3 }),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('applied');
      expect(deps.actionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'applied' }),
      );
      expect(deps.reviewQueue.enqueue).not.toHaveBeenCalled();
    });

    it('auto-applies auto_above_threshold action when confidence >= threshold', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.8 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('applied');
      expect(deps.reviewQueue.enqueue).not.toHaveBeenCalled();
    });

    it('defers auto_above_threshold action when confidence < threshold', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.5 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
      expect(deps.reviewQueue.enqueue).toHaveBeenCalled();
    });

    it('defers batch_review actions regardless of confidence', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'merge_fields',
        payload: {
          canonicalName: 'name',
          aliasNames: ['title'],
          canonicalDefinition: {
            name: 'name',
            description: 'Name',
            type: 'string',
            required: true,
          },
          valueMappings: {},
        },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
      expect(deps.reviewQueue.enqueue).toHaveBeenCalled();
    });

    it('defers always_review actions', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'remove_field',
        payload: { fieldName: 'title', reason: 'irrelevant' },
      };

      const result = await executor.execute(action);

      expect(result.status).toBe('deferred');
    });

    it('auto-applies everything under trust_ai preset', async () => {
      executor = new DefaultActionExecutor({
        actionRepo: deps.actionRepo as any,
        schemaRepo: deps.schemaRepo as any,
        entityRepo: deps.entityRepo as any,
        entitySourceRepo: deps.entitySourceRepo as any,
        sourceTrustRepo: deps.sourceTrustRepo as any,
        reviewQueue: deps.reviewQueue as any,
        approvalPreset: 'trust_ai',
        confidenceThreshold: 0.7,
        tenantId: 'tenant-1',
      });

      const action: PipelineAction = {
        ...baseAction({ confidence: 0.3 }),
        type: 'remove_field',
        payload: { fieldName: 'title', reason: 'irrelevant' },
      };

      const result = await executor.execute(action);
      expect(result.status).toBe('applied');
    });

    it('defers everything under manual preset', async () => {
      executor = new DefaultActionExecutor({
        actionRepo: deps.actionRepo as any,
        schemaRepo: deps.schemaRepo as any,
        entityRepo: deps.entityRepo as any,
        entitySourceRepo: deps.entitySourceRepo as any,
        sourceTrustRepo: deps.sourceTrustRepo as any,
        reviewQueue: deps.reviewQueue as any,
        approvalPreset: 'manual',
        confidenceThreshold: 0.7,
        tenantId: 'tenant-1',
      });

      const action: PipelineAction = {
        ...baseAction({ confidence: 1.0 }),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const result = await executor.execute(action);
      expect(result.status).toBe('deferred');
    });
  });

  describe('preview', () => {
    it('returns preview with requiresApproval based on policy', async () => {
      const action: PipelineAction = {
        ...baseAction({ confidence: 0.5 }),
        type: 'add_field',
        payload: {
          field: { name: 'price', description: 'Price', type: 'number', required: false },
          relevance: {
            globalFrequency: 0.8,
            categoryBreakdown: [],
            classification: 'universal_optional',
            applicableCategories: null,
          },
        },
      };

      const preview = await executor.preview(action);

      expect(preview.requiresApproval).toBe(true);
      expect(preview.riskLevel).toBeDefined();
    });

    it('returns requiresApproval=false for always_auto action', async () => {
      const action: PipelineAction = {
        ...baseAction(),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const preview = await executor.preview(action);
      expect(preview.requiresApproval).toBe(false);
    });

    it('assesses high risk for remove_field', async () => {
      const action: PipelineAction = {
        ...baseAction(),
        type: 'remove_field',
        payload: { fieldName: 'title', reason: 'irrelevant' },
      };

      const preview = await executor.preview(action);
      expect(preview.riskLevel).toBe('high');
    });

    it('assesses medium risk for merge_fields', async () => {
      const action: PipelineAction = {
        ...baseAction(),
        type: 'merge_fields',
        payload: {
          canonicalName: 'name',
          aliasNames: ['title'],
          canonicalDefinition: {
            name: 'name',
            description: 'Name',
            type: 'string',
            required: true,
          },
          valueMappings: {},
        },
      };

      const preview = await executor.preview(action);
      expect(preview.riskLevel).toBe('medium');
    });

    it('assesses low risk for classify_page', async () => {
      const action: PipelineAction = {
        ...baseAction(),
        type: 'classify_page',
        payload: {
          pageId: generateId(),
          classification: 'single_entry',
          extractionStrategy: 'full_page',
        },
      };

      const preview = await executor.preview(action);
      expect(preview.riskLevel).toBe('low');
    });
  });

  describe('rollback', () => {
    it('throws for reconciliation actions (not supported in v1)', async () => {
      deps.actionRepo.findById.mockResolvedValue({
        id: 'action-1',
        type: 'resolve_conflict',
        status: 'applied',
      });

      await expect(executor.rollback('action-1')).rejects.toThrow('not supported');
    });

    it('throws when action not found', async () => {
      deps.actionRepo.findById.mockResolvedValue(null);

      await expect(executor.rollback('nonexistent')).rejects.toThrow('not found');
    });

    it('throws when action was not applied', async () => {
      deps.actionRepo.findById.mockResolvedValue({
        id: 'action-1',
        type: 'add_field',
        status: 'pending_review',
      });

      await expect(executor.rollback('action-1')).rejects.toThrow('not applied');
    });

    it('rolls back a non-reconciliation applied action', async () => {
      deps.actionRepo.findById.mockResolvedValue({
        id: 'action-1',
        type: 'add_field',
        status: 'applied',
      });

      await executor.rollback('action-1');

      expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith(
        'action-1',
        'tenant-1',
        'rolled_back',
      );
    });
  });
});
