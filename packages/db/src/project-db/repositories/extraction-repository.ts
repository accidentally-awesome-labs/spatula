/**
 * SQLite extraction repository — local project mode.
 *
 * Implements ExtractionRepo from @spatula/core/pipeline/types.ts.
 *
 * Key differences from Postgres ExtractionRepository:
 * - No tenantId filtering (single-user local mode)
 * - jobId auto-set from pre-bound projectId on every insert
 * - No ::int cast on count(*) — uses plain sql`count(*)` with Number() wrap
 * - UUIDs via crypto.randomUUID(), timestamps via new Date().toISOString()
 */
import { eq, and, desc } from 'drizzle-orm';
import type { ExtractionRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { extractions } from '../../schema-sqlite/extractions.js';
import { wrapStorageError } from './utils.js';

export class SqliteExtractionRepository implements ExtractionRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async store(data: {
    jobId: string;
    tenantId: string;
    pageId: string;
    schemaVersion: number;
    data: Record<string, unknown>;
    unmappedFields: unknown[];
    metadata: unknown;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    wrapStorageError(() => {
      this.db
        .insert(extractions)
        .values({
          id,
          jobId: this.projectId,
          pageId: data.pageId,
          schemaVersion: data.schemaVersion,
          data: data.data,
          unmappedFields: data.unmappedFields as Record<string, unknown>[],
          metadata: (data.metadata ?? {}) as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        })
        .run();
    }, { method: 'store', table: 'extractions' });
    return { id };
  }

  async findByJob(
    _jobId: string,
    _tenantId: string,
    options?: { schemaVersion?: number; limit?: number; offset?: number },
  ): Promise<
    Array<{
      id: string;
      jobId: string;
      pageId: string;
      schemaVersion: number;
      data: unknown;
      metadata: unknown;
    }>
  > {
    const conditions = [eq(extractions.jobId, this.projectId)];
    if (options?.schemaVersion !== undefined) {
      conditions.push(eq(extractions.schemaVersion, options.schemaVersion));
    }

    let query = this.db
      .select()
      .from(extractions)
      .where(and(...conditions))
      .orderBy(desc(extractions.createdAt));

    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    return query.all();
  }
}
