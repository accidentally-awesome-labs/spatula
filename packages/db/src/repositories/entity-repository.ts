import { eq, and, desc, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { entities, entitySources } from '../schema/entities.js';
import type { Database } from '../connection.js';
import type { RedisCache } from '../cache.js';

const logger = createLogger('entity-repository');

export interface CreateEntityInput {
  jobId: string;
  tenantId: string;
  mergedData: Record<string, unknown>;
  provenance: Record<string, unknown>;
  categories?: string[];
  qualityScore?: number;
}

export class EntityRepository {
  private cache?: RedisCache;

  constructor(private readonly db: Database) {}

  setCache(cache: RedisCache): void {
    this.cache = cache;
  }

  async create(input: CreateEntityInput) {
    try {
      const [row] = await this.db
        .insert(entities)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          mergedData: input.mergedData,
          provenance: input.provenance,
          ...(input.categories !== undefined ? { categories: input.categories } : {}),
          ...(input.qualityScore !== undefined ? { qualityScore: input.qualityScore } : {}),
          updatedAt: new Date(),
        })
        .returning();

      logger.debug({ entityId: row.id, jobId: input.jobId }, 'entity created');

      // Invalidate cached entity count for this job
      if (this.cache) {
        await this.cache.invalidate(`entity-count:${input.jobId}`);
      }

      return row;
    } catch (error) {
      throw new StorageError(`Failed to create entity: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId },
      });
    }
  }

  async findById(entityId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(entities)
        .where(and(eq(entities.id, entityId), eq(entities.tenantId, tenantId)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find entity ${entityId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId, tenantId },
      });
    }
  }

  async findByJob(jobId: string, tenantId: string, options?: { limit?: number; offset?: number; search?: string }) {
    try {
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];

      if (options?.search) {
        conditions.push(
          sql`${entities.mergedData}::text ILIKE ${'%' + options.search + '%'}`,
        );
      }

      let query = this.db
        .select({
          id: entities.id,
          jobId: entities.jobId,
          tenantId: entities.tenantId,
          mergedData: entities.mergedData,
          categories: entities.categories,
          qualityScore: entities.qualityScore,
          createdAt: entities.createdAt,
          sourceCount: sql<number>`(SELECT count(*)::int FROM entity_sources es WHERE es.entity_id = ${entities.id})`.as('source_count'),
        })
        .from(entities)
        .where(and(...conditions))
        .orderBy(desc(entities.qualityScore));

      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }

      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find entities: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByJobWithProvenance(jobId: string, tenantId: string, options?: { limit?: number; offset?: number }) {
    try {
      let query = this.db
        .select()
        .from(entities)
        .where(and(eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)))
        .orderBy(desc(entities.qualityScore));

      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }

      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find entities with provenance: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async countByJob(jobId: string, tenantId: string, options?: { search?: string }): Promise<number> {
    // Only cache when there's no search filter (search results are too dynamic)
    if (this.cache && !options?.search) {
      const cacheKey = `entity-count:${jobId}`;
      return this.cache.getOrFetch(
        cacheKey,
        () => this._countByJobFromDb(jobId, tenantId, options),
        10,
      );
    }
    return this._countByJobFromDb(jobId, tenantId, options);
  }

  private async _countByJobFromDb(jobId: string, tenantId: string, options?: { search?: string }): Promise<number> {
    try {
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];

      if (options?.search) {
        conditions.push(
          sql`${entities.mergedData}::text ILIKE ${'%' + options.search + '%'}`,
        );
      }

      const [result] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));

      return result?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count entities: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async updateQualityScore(entityId: string, tenantId: string, score: number) {
    try {
      const [row] = await this.db
        .update(entities)
        .set({ qualityScore: score, updatedAt: new Date() })
        .where(and(eq(entities.id, entityId), eq(entities.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Entity ${entityId} not found`, {
          context: { entityId, tenantId },
        });
      }

      logger.debug({ entityId, score }, 'entity quality score updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update entity quality score: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId, tenantId, score },
      });
    }
  }

  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
  ): Promise<{ entities: Array<typeof entities.$inferSelect>; nextCursor: string | null }> {
    try {
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];
      if (cursor) {
        conditions.push(sql`${entities.id} > ${cursor}`);
      }
      if (since) conditions.push(sql`${entities.updatedAt} > ${since}`);

      const rows = await this.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(entities.id)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
      return { entities: rows, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to fetch entities by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId, cursor },
      });
    }
  }

  async updateMergedData(
    entityId: string,
    tenantId: string,
    changes: {
      mergedData?: Record<string, unknown>;
      provenance?: Record<string, unknown>;
      categories?: string[];
    },
  ) {
    try {
      const setClause: Record<string, unknown> = {};
      if (changes.mergedData !== undefined) setClause.mergedData = changes.mergedData;
      if (changes.provenance !== undefined) setClause.provenance = changes.provenance;
      if (changes.categories !== undefined) setClause.categories = changes.categories;
      setClause.updatedAt = new Date();

      const [row] = await this.db
        .update(entities)
        .set(setClause)
        .where(and(eq(entities.id, entityId), eq(entities.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Entity ${entityId} not found`, {
          context: { entityId, tenantId },
        });
      }

      logger.debug({ entityId }, 'entity merged data updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update entity data: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId, tenantId },
      });
    }
  }
}
