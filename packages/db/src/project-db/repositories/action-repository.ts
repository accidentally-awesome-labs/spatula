/**
 * SQLite action repository — local project mode.
 *
 * Implements ActionRepo from @spatula/core/pipeline/types.ts.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 */
import { eq, and, desc } from 'drizzle-orm';
import type { ActionRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { actions } from '../../schema-sqlite/actions.js';

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
      })
      .run();
    return { id };
  }

  /**
   * Find actions for the project with optional status filter.
   * Extends the pipeline interface with filter support for CLI usage.
   */
  async findByJob(
    _jobId: string,
    options?: { status?: string; limit?: number; offset?: number },
  ): Promise<Array<{
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
  }>> {
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
}
