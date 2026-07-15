import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { PipelineAction } from '../types/actions.js';
import type { ActionPreview } from '../interfaces/action-executor.js';

const logger = createLogger('review-queue');

export interface ReviewQueueActionRepo {
  create(input: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    source: string;
    status: string;
    confidence: number;
    reasoning: string;
    stateChanges?: Record<string, unknown>;
  }): Promise<{ id: string }>;

  findByJob(
    jobId: string,
    tenantId: string,
    options?: { type?: string; status?: string; limit?: number; offset?: number },
  ): Promise<Array<{ id: string; [key: string]: unknown }>>;

  updateStatus(
    actionId: string,
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown>;

  batchUpdateStatus(
    actionIds: string[],
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown[]>;
}

export interface ReviewQueue {
  enqueue(action: PipelineAction, tenantId: string, preview: ActionPreview): Promise<void>;
  getPending(
    jobId: string,
    tenantId: string,
    options?: { type?: string; limit?: number },
  ): Promise<Array<{ id: string; [key: string]: unknown }>>;
  approve(actionId: string, tenantId: string, reviewedBy: string): Promise<unknown>;
  reject(actionId: string, tenantId: string, reviewedBy: string, reason: string): Promise<void>;
  approveAll(jobId: string, tenantId: string, reviewedBy: string): Promise<unknown[]>;
}

export class DefaultReviewQueue implements ReviewQueue {
  constructor(private readonly actionRepo: ReviewQueueActionRepo) {}

  async enqueue(action: PipelineAction, tenantId: string, preview: ActionPreview): Promise<void> {
    const payload = 'payload' in action ? (action as any).payload : {};

    await this.actionRepo.create({
      jobId: action.jobId,
      tenantId,
      type: action.type,
      payload: { ...payload, _preview: preview },
      source: action.source,
      status: 'pending_review',
      confidence: action.confidence,
      reasoning: action.reasoning,
    });

    logger.debug({ type: action.type, jobId: action.jobId }, 'action enqueued for review');
  }

  async getPending(
    jobId: string,
    tenantId: string,
    options?: { type?: string; limit?: number },
  ): Promise<Array<{ id: string; [key: string]: unknown }>> {
    return this.actionRepo.findByJob(jobId, tenantId, {
      status: 'pending_review',
      ...(options?.type ? { type: options.type } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  async approve(actionId: string, tenantId: string, reviewedBy: string): Promise<unknown> {
    return this.actionRepo.updateStatus(actionId, tenantId, 'approved', reviewedBy);
  }

  async reject(
    actionId: string,
    tenantId: string,
    reviewedBy: string,
    _reason: string,
  ): Promise<void> {
    await this.actionRepo.updateStatus(actionId, tenantId, 'rejected', reviewedBy);
  }

  async approveAll(jobId: string, tenantId: string, reviewedBy: string): Promise<unknown[]> {
    const pending = await this.actionRepo.findByJob(jobId, tenantId, {
      status: 'pending_review',
    });

    if (pending.length === 0) return [];

    const ids = pending.map((a) => a.id);
    return this.actionRepo.batchUpdateStatus(ids, tenantId, 'approved', reviewedBy);
  }
}
