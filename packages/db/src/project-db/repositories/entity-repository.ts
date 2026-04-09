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
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import type { EntityRepo, EntitySourceRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { entities, entitySources } from '../../schema-sqlite/entities.js';
import { runs } from '../../schema-sqlite/runs.js';
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

  async upsertBatch(batch: Array<{
    id: string;
    mergedData: Record<string, unknown>;
    provenance: Record<string, unknown>;
    qualityScore: number;
    categories: unknown[];
    runId: string | null;
  }>): Promise<{ inserted: number; updated: number }> {
    if (batch.length === 0) return { inserted: 0, updated: 0 };

    // Check which IDs already exist to accurately track insert vs update
    const existingIds = new Set<string>();
    wrapStorageError(() => {
      const ids = batch.map(e => e.id);
      for (let i = 0; i < ids.length; i += 999) {
        const chunk = ids.slice(i, i + 999);
        const rows = this.db.select({ id: entities.id }).from(entities).where(inArray(entities.id, chunk)).all();
        for (const row of rows) existingIds.add(row.id);
      }
    }, { method: 'upsertBatch:check', table: 'entities' });

    const now = new Date().toISOString();

    wrapStorageError(() => {
      for (const entity of batch) {
        this.db
          .insert(entities)
          .values({
            id: entity.id,
            jobId: this.projectId,
            mergedData: entity.mergedData,
            provenance: entity.provenance,
            qualityScore: entity.qualityScore,
            categories: entity.categories,
            createdAt: now,
            updatedAt: now,
            runId: entity.runId,
          })
          .onConflictDoUpdate({
            target: entities.id,
            set: {
              mergedData: entity.mergedData,
              provenance: entity.provenance,
              qualityScore: entity.qualityScore,
              categories: entity.categories,
              updatedAt: now,
              runId: entity.runId,
            },
          })
          .run();
      }
    }, { method: 'upsertBatch', table: 'entities' });

    const updated = existingIds.size;
    const inserted = batch.length - updated;
    return { inserted, updated };
  }

  async deleteByRunIds(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    // Count matching entities before deleting
    const [{ count }] = this.db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(inArray(entities.runId, runIds))
      .all();
    if (Number(count) === 0) return 0;
    wrapStorageError(() => {
      this.db.delete(entities).where(inArray(entities.runId, runIds)).run();
    }, { method: 'deleteByRunIds', table: 'entities' });
    return Number(count);
  }

  async countBySource(filter: 'all' | 'local' | 'remote'): Promise<number> {
    if (filter === 'all') {
      return this.countByJob(this.projectId, '');
    }
    let result: { count: number }[];
    if (filter === 'local') {
      result = this.db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .leftJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND (${entities.runId} IS NULL OR ${runs.source} = 'local')`)
        .all();
    } else {
      result = this.db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .innerJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND ${runs.source} LIKE 'remote:%'`)
        .all();
    }
    return Number(result[0]?.count ?? 0);
  }

  async findByJobFiltered(
    _jobId: string,
    _tenantId: string,
    options?: { limit: number; offset: number; sourceFilter?: 'all' | 'local' | 'remote' },
  ): Promise<unknown[]> {
    const filter = options?.sourceFilter ?? 'all';
    if (filter === 'all') {
      return this.findByJob(_jobId, _tenantId, options);
    }
    let query;
    if (filter === 'local') {
      query = this.db
        .select({
          id: entities.id, jobId: entities.jobId,
          mergedData: entities.mergedData, categories: entities.categories,
          qualityScore: entities.qualityScore, createdAt: entities.createdAt,
          sourceCount: entities.sourceCount,
        })
        .from(entities)
        .leftJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND (${entities.runId} IS NULL OR ${runs.source} = 'local')`)
        .orderBy(desc(entities.qualityScore));
    } else {
      query = this.db
        .select({
          id: entities.id, jobId: entities.jobId,
          mergedData: entities.mergedData, categories: entities.categories,
          qualityScore: entities.qualityScore, createdAt: entities.createdAt,
          sourceCount: entities.sourceCount,
        })
        .from(entities)
        .innerJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND ${runs.source} LIKE 'remote:%'`)
        .orderBy(desc(entities.qualityScore));
    }
    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }
    return query.all();
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

  async upsertBatchSources(batch: Array<{
    entityId: string;
    extractionId: string;
    matchConfidence: number;
  }>): Promise<number> {
    if (batch.length === 0) return 0;
    let count = 0;
    wrapStorageError(() => {
      for (const item of batch) {
        this.db.insert(entitySources).values(item)
          .onConflictDoUpdate({
            target: [entitySources.entityId, entitySources.extractionId],
            set: { matchConfidence: item.matchConfidence },
          }).run();
        count++;
      }
    }, { method: 'upsertBatchSources', table: 'entity_sources' });
    return count;
  }

  async deleteByExtractionIds(extractionIds: string[]): Promise<number> {
    if (extractionIds.length === 0) return 0;
    let total = 0;
    wrapStorageError(() => {
      for (const id of extractionIds) {
        const result = this.db.delete(entitySources)
          .where(eq(entitySources.extractionId, id)).run();
        total += result.changes;
      }
    }, { method: 'deleteByExtractionIds', table: 'entity_sources' });
    return total;
  }
}
