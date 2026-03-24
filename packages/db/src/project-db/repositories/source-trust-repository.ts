/**
 * SQLite source-trust repository — local project mode.
 *
 * Implements SourceTrustRepo from @spatula/core/pipeline/types.ts.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 *
 * KNOWN LIMITATION: The pipeline interface requires `reasoning: string`
 * in upsert data, but the SQLite source_trust table drops the `reasoning`
 * column (per spec section 5.3). The parameter is accepted but NOT
 * persisted — it is silently discarded. The `score` field (local
 * extension) defaults to 0.5 if not provided.
 */
import { eq, and } from 'drizzle-orm';
import type { SourceTrustRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { sourceTrust } from '../../schema-sqlite/source-trust.js';

export class SqliteSourceTrustRepository implements SourceTrustRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async upsert(data: {
    jobId: string;
    tenantId: string;
    domain: string;
    trustLevel: string;
    reasoning: string;
    score?: number;
  }): Promise<unknown> {
    const id = crypto.randomUUID();

    // Synchronous transaction for better-sqlite3
    this.db.transaction((tx) => {
      // Delete existing record for this domain (if any)
      tx.delete(sourceTrust)
        .where(
          and(
            eq(sourceTrust.jobId, this.projectId),
            eq(sourceTrust.domain, data.domain),
          ),
        )
        .run();

      // Insert new record — reasoning is NOT persisted (column doesn't exist)
      tx.insert(sourceTrust)
        .values({
          id,
          jobId: this.projectId,
          domain: data.domain,
          trustLevel: data.trustLevel,
          score: data.score ?? 0.5,
          createdAt: new Date().toISOString(),
        })
        .run();
    });

    return { id };
  }

  async findByJob(_jobId: string): Promise<Array<{
    id: string;
    domain: string;
    trustLevel: string;
    score: number | null;
    createdAt: string;
  }>> {
    return this.db
      .select()
      .from(sourceTrust)
      .where(eq(sourceTrust.jobId, this.projectId))
      .all();
  }
}
