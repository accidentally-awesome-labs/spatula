import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { entities } from '../schema/entities.js';
import type { Database } from '../connection.js';

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
  constructor(private readonly db: Database) {}

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
        })
        .returning();

      logger.debug({ entityId: row.id, jobId: input.jobId }, 'entity created');
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

  async findByJob(jobId: string, tenantId: string, options?: { limit?: number; offset?: number }) {
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
      throw new StorageError(`Failed to find entities: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async updateQualityScore(entityId: string, tenantId: string, score: number) {
    try {
      const [row] = await this.db
        .update(entities)
        .set({ qualityScore: score })
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
}
