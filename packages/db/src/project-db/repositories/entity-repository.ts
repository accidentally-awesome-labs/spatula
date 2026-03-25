/**
 * SQLite entity + entity-source repositories — local project mode.
 *
 * Implements EntityRepo and EntitySourceRepo from @spatula/core/pipeline/types.ts.
 * Both repos live in one file since entity_sources is a junction table tightly
 * coupled to entities.
 *
 * Key differences from Postgres:
 * - No tenantId filtering (single-user local mode)
 * - jobId auto-set from pre-bound projectId
 * - categories is JSON text (Postgres uses text[])
 * - count(*) uses plain sql`count(*)` — NO ::int cast (invalid in SQLite)
 * - UUIDs via crypto.randomUUID(), timestamps via new Date().toISOString()
 */
import { eq, desc, sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import type { EntityRepo, EntitySourceRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { entities, entitySources } from '../../schema-sqlite/entities.js';
import { wrapStorageError } from './utils.js';

const logger = createLogger('sqlite:entity-repo');

export class SqliteEntityRepository implements EntityRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async create(data: {
    jobId: string;
    tenantId: string;
    mergedData: Record<string, unknown>;
    provenance: Record<string, unknown>;
    qualityScore: number;
    categories?: unknown[];
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    wrapStorageError(() => {
      this.db
        .insert(entities)
        .values({
          id,
          jobId: this.projectId,
          mergedData: data.mergedData,
          provenance: data.provenance,
          qualityScore: data.qualityScore,
          ...(data.categories !== undefined ? { categories: data.categories } : {}),
          createdAt: new Date().toISOString(),
        })
        .run();
    }, { method: 'create', table: 'entities' });
    logger.debug({ id }, 'entity created');
    return { id };
  }

  async findByJob(
    _jobId: string,
    _tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<unknown[]> {
    let query = this.db
      .select({
        id: entities.id,
        jobId: entities.jobId,
        mergedData: entities.mergedData,
        categories: entities.categories,
        qualityScore: entities.qualityScore,
        createdAt: entities.createdAt,
        sourceCount: entities.sourceCount,
      })
      .from(entities)
      .where(eq(entities.jobId, this.projectId))
      .orderBy(desc(entities.qualityScore));

    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    return query.all();
  }

  async findByJobWithProvenance(
    _jobId: string,
    _tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<unknown[]> {
    let query = this.db
      .select()
      .from(entities)
      .where(eq(entities.jobId, this.projectId))
      .orderBy(desc(entities.qualityScore));

    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    return query.all();
  }

  async countByJob(_jobId: string, _tenantId: string): Promise<number> {
    const [result] = this.db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(eq(entities.jobId, this.projectId))
      .all();

    return Number(result?.count ?? 0);
  }
}

export class SqliteEntitySourceRepository implements EntitySourceRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly _projectId: string,
  ) {}

  async bulkLink(
    links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
  ): Promise<{ count: number }> {
    if (links.length === 0) return { count: 0 };

    wrapStorageError(() => {
      this.db.insert(entitySources).values(links).run();
    }, { method: 'bulkLink', table: 'entity_sources' });
    return { count: links.length };
  }
}
