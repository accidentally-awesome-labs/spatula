import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultReviewQueue } from '../../../src/execution/review-queue.js';
import type { PipelineAction } from '../../../src/types/actions.js';
import type { ActionPreview } from '../../../src/interfaces/action-executor.js';
import { generateId } from '@accidentally-awesome-labs/spatula-shared';

function baseAction(): PipelineAction {
  return {
    id: generateId(),
    jobId: 'job-1',
    source: 'schema_evolution',
    reasoning: 'test',
    confidence: 0.8,
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
}

function makePreview(): ActionPreview {
  return {
    actionId: generateId(),
    wouldChange: [{ path: 'schema.fields', before: [], after: [{ name: 'price' }] }],
    riskLevel: 'low',
    requiresApproval: true,
  };
}

function createMockActionRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'action-1' }),
    findByJob: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue({ id: 'action-1', status: 'approved' }),
    batchUpdateStatus: vi.fn().mockResolvedValue([]),
  };
}

describe('DefaultReviewQueue', () => {
  let actionRepo: ReturnType<typeof createMockActionRepo>;
  let queue: DefaultReviewQueue;

  beforeEach(() => {
    actionRepo = createMockActionRepo();
    queue = new DefaultReviewQueue(actionRepo as any);
  });

  describe('enqueue', () => {
    it('creates action with pending_review status and correct tenantId', async () => {
      const action = baseAction();
      const preview = makePreview();

      await queue.enqueue(action, 'tenant-1', preview);

      expect(actionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          tenantId: 'tenant-1',
          type: 'add_field',
          status: 'pending_review',
        }),
      );
    });

    it('stores preview data in payload', async () => {
      const action = baseAction();
      const preview = makePreview();

      await queue.enqueue(action, 'tenant-1', preview);

      const createArg = actionRepo.create.mock.calls[0][0];
      expect(createArg.payload).toHaveProperty('_preview');
    });
  });

  describe('getPending', () => {
    it('fetches pending_review actions for a job', async () => {
      actionRepo.findByJob.mockResolvedValue([
        { id: 'a-1', type: 'add_field', status: 'pending_review' },
      ]);

      const pending = await queue.getPending('job-1', 'tenant-1');

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
      });
      expect(pending).toHaveLength(1);
    });

    it('supports filtering by type', async () => {
      await queue.getPending('job-1', 'tenant-1', { type: 'merge_fields' });

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
        type: 'merge_fields',
      });
    });

    it('supports limit option', async () => {
      await queue.getPending('job-1', 'tenant-1', { limit: 10 });

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
        limit: 10,
      });
    });
  });

  describe('approve', () => {
    it('updates status to approved', async () => {
      actionRepo.updateStatus.mockResolvedValue({ id: 'a-1', status: 'approved' });

      await queue.approve('a-1', 'tenant-1', 'user@example.com');

      expect(actionRepo.updateStatus).toHaveBeenCalledWith(
        'a-1',
        'tenant-1',
        'approved',
        'user@example.com',
      );
    });
  });

  describe('reject', () => {
    it('updates status to rejected', async () => {
      await queue.reject('a-1', 'tenant-1', 'user@example.com', 'Not needed');

      expect(actionRepo.updateStatus).toHaveBeenCalledWith(
        'a-1',
        'tenant-1',
        'rejected',
        'user@example.com',
      );
    });
  });

  describe('approveAll', () => {
    it('approves all pending actions for a job', async () => {
      actionRepo.findByJob.mockResolvedValue([
        { id: 'a-1', status: 'pending_review' },
        { id: 'a-2', status: 'pending_review' },
      ]);
      actionRepo.batchUpdateStatus.mockResolvedValue([
        { id: 'a-1', status: 'approved' },
        { id: 'a-2', status: 'approved' },
      ]);

      const results = await queue.approveAll('job-1', 'tenant-1', 'user@example.com');

      expect(actionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
        status: 'pending_review',
      });
      expect(actionRepo.batchUpdateStatus).toHaveBeenCalledWith(
        ['a-1', 'a-2'],
        'tenant-1',
        'approved',
        'user@example.com',
      );
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no pending actions exist', async () => {
      actionRepo.findByJob.mockResolvedValue([]);

      const results = await queue.approveAll('job-1', 'tenant-1', 'user@example.com');
      expect(results).toHaveLength(0);
      expect(actionRepo.batchUpdateStatus).not.toHaveBeenCalled();
    });
  });
});
