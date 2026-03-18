import { eq, and, desc, inArray } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { actions } from '../schema/actions.js';
import { actionStatusEnum } from '../schema/enums.js';
import type { Database } from '../connection.js';

const logger = createLogger('action-repository');

export type ActionStatus = (typeof actionStatusEnum.enumValues)[number];

export interface FindActionsOptions {
  type?: string;
  status?: ActionStatus;
  limit?: number;
  offset?: number;
}

export interface CreateActionInput {
  jobId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  source: string;
  status: string;
  confidence: number;
  reasoning: string;
  stateChanges?: Record<string, unknown>;
}

export class ActionRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateActionInput): Promise<{ id: string }> {
    try {
      const [row] = await this.db
        .insert(actions)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          type: input.type,
          payload: input.payload,
          source: input.source as any,
          status: (input.status as any) ?? 'pending_review',
          confidence: input.confidence,
          reasoning: input.reasoning,
          stateChanges: input.stateChanges ?? null,
        })
        .returning({ id: actions.id });

      logger.debug({ actionId: row.id, type: input.type }, 'action created');
      return { id: row.id };
    } catch (error) {
      throw new StorageError(`Failed to create action: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, type: input.type },
      });
    }
  }

  async findByJob(jobId: string, tenantId: string, options?: FindActionsOptions) {
    try {
      let query = this.db
        .select()
        .from(actions)
        .where(
          and(
            eq(actions.jobId, jobId),
            eq(actions.tenantId, tenantId),
            ...(options?.type ? [eq(actions.type, options.type)] : []),
            ...(options?.status ? [eq(actions.status, options.status)] : []),
          ),
        )
        .orderBy(desc(actions.createdAt));

      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }

      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find actions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }

  async findById(actionId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(actions)
        .where(and(eq(actions.id, actionId), eq(actions.tenantId, tenantId)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find action ${actionId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { actionId, tenantId },
      });
    }
  }

  async updateStatus(
    actionId: string,
    tenantId: string,
    status: ActionStatus,
    reviewedBy?: string,
  ) {
    try {
      const [row] = await this.db
        .update(actions)
        .set({
          status,
          ...(reviewedBy ? { reviewedBy } : {}),
          ...(status === 'applied' ? { appliedAt: new Date() } : {}),
        })
        .where(and(eq(actions.id, actionId), eq(actions.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Action ${actionId} not found`, {
          context: { actionId, tenantId },
        });
      }

      logger.debug({ actionId, status }, 'action status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update action status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { actionId, tenantId, status },
      });
    }
  }

  async batchUpdateStatus(
    actionIds: string[],
    tenantId: string,
    status: ActionStatus,
    reviewedBy?: string,
  ) {
    try {
      const rows = await this.db
        .update(actions)
        .set({
          status,
          ...(reviewedBy ? { reviewedBy } : {}),
          ...(status === 'applied' ? { appliedAt: new Date() } : {}),
        })
        .where(and(inArray(actions.id, actionIds), eq(actions.tenantId, tenantId)))
        .returning();

      logger.debug({ count: rows.length, status }, 'batch action status updated');
      return rows;
    } catch (error) {
      throw new StorageError(`Failed to batch update action status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { count: actionIds.length, tenantId, status },
      });
    }
  }
}
