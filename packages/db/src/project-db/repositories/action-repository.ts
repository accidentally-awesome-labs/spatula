/**
 * SQLite action repository — local project mode.
 *
 * Implements ActionRepo from @spatula/core/pipeline/types.ts.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 */
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { ActionRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { actions } from '../../schema-sqlite/actions.js';
import { wrapStorageError } from './utils.js';

export class SqliteActionRepository implements ActionRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async create(data: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: unknown;
    source: string;
    status: string;
    confidence?: number;
    reasoning?: string;
  }): Promise<unknown> {
    const id = crypto.randomUUID();
    wrapStorageError(
      () => {
        this.db
          .insert(actions)
          .values({
            id,
            jobId: this.projectId,
            type: data.type,
            payload: data.payload as Record<string, unknown>,
            source: data.source,
            status: data.status ?? 'pending_review',
            confidence: data.confidence ?? 0,
            reasoning: data.reasoning ?? '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run();
      },
      { method: 'create', table: 'actions' },
    );
    return { id };
  }

  /**
   * Find actions for the project with optional status filter.
   * Extends the pipeline interface with filter support for CLI usage.
   */
  async findByJob(
    _jobId: string,
    options?: { status?: string; limit?: number; offset?: number },
  ): Promise<
    Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      source: string;
      status: string;
      confidence: number;
      reasoning: string;
      reviewedBy: string | null;
      createdAt: string;
      appliedAt: string | null;
    }>
  > {
    const conditions = [eq(actions.jobId, this.projectId)];
    if (options?.status) {
      conditions.push(eq(actions.status, options.status));
    }

    let query = this.db
      .select()
      .from(actions)
      .where(and(...conditions))
      .orderBy(desc(actions.createdAt));

    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }

    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    return query.all();
  }

  async updateStatus(
    actionId: string,
    _tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown> {
    this.db
      .update(actions)
      .set({
        status,
        ...(reviewedBy ? { reviewedBy } : {}),
        ...(status === 'applied' ? { appliedAt: new Date().toISOString() } : {}),
      })
      .where(eq(actions.id, actionId))
      .run();

    return {};
  }

  async upsertBatch(
    batch: Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      source: string;
      status: string;
      confidence: number;
      reasoning: string;
      runId: string | null;
      createdAt: string;
      updatedAt: string;
      appliedAt: string | null;
      stateChanges?: Record<string, unknown> | null;
      reviewedBy?: string | null;
    }>,
  ): Promise<{ inserted: number; updated: number }> {
    if (batch.length === 0) return { inserted: 0, updated: 0 };

    const existingIds = new Set<string>();
    wrapStorageError(
      () => {
        const ids = batch.map((item) => item.id);
        for (let i = 0; i < ids.length; i += 999) {
          const chunk = ids.slice(i, i + 999);
          const rows = this.db
            .select({ id: actions.id })
            .from(actions)
            .where(inArray(actions.id, chunk))
            .all();
          for (const row of rows) existingIds.add(row.id);
        }
      },
      { method: 'upsertBatch:check', table: 'actions' },
    );

    // Track IDs seen within this batch to count within-batch duplicates as updates
    const seenInBatch = new Set<string>();
    wrapStorageError(
      () => {
        for (const item of batch) {
          if (!existingIds.has(item.id) && !seenInBatch.has(item.id)) {
            seenInBatch.add(item.id);
          } else {
            existingIds.add(item.id);
          }
          this.db
            .insert(actions)
            .values({
              id: item.id,
              jobId: this.projectId,
              type: item.type,
              payload: item.payload,
              source: item.source,
              status: item.status,
              confidence: item.confidence,
              reasoning: item.reasoning,
              stateChanges: item.stateChanges ?? null,
              reviewedBy: item.reviewedBy ?? null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              appliedAt: item.appliedAt,
              runId: item.runId,
            })
            .onConflictDoUpdate({
              target: actions.id,
              set: {
                status: item.status,
                reasoning: item.reasoning,
                updatedAt: item.updatedAt,
                runId: item.runId,
                stateChanges: item.stateChanges ?? null,
                reviewedBy: item.reviewedBy ?? null,
              },
            })
            .run();
        }
      },
      { method: 'upsertBatch', table: 'actions' },
    );

    return { inserted: batch.length - existingIds.size, updated: existingIds.size };
  }

  async deleteByRunIds(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    let total = 0;
    wrapStorageError(
      () => {
        for (const runId of runIds) {
          const result = this.db
            .delete(actions)
            .where(and(eq(actions.jobId, this.projectId), eq(actions.runId, runId)))
            .run();
          total += result.changes;
        }
      },
      { method: 'deleteByRunIds', table: 'actions' },
    );
    return total;
  }
}
