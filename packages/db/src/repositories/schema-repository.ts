import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { SchemaDefinition } from '@spatula/core';
import { schemasTable } from '../schema/schemas.js';
import type { Database } from '../connection.js';
import type { RedisCache } from '../cache.js';

const logger = createLogger('schema-repository');

export interface CreateSchemaInput {
  jobId: string;
  tenantId: string;
  version: number;
  definition: SchemaDefinition;
  parentId?: string;
}

export class SchemaRepository {
  private cache?: RedisCache;

  constructor(private readonly db: Database) {}

  setCache(cache: RedisCache): void {
    this.cache = cache;
  }

  async create(input: CreateSchemaInput) {
    try {
      const [row] = await this.db
        .insert(schemasTable)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          version: input.version,
          definition: input.definition,
          parentId: input.parentId,
        })
        .returning();

      logger.debug({ schemaId: row.id, version: input.version }, 'schema version created');

      // Invalidate cached schema for this job
      if (this.cache) {
        await this.cache.delete(`schema:${input.jobId}:current`);
      }

      return row;
    } catch (error) {
      throw new StorageError(`Failed to create schema: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, version: input.version },
      });
    }
  }

  async findLatest(jobId: string, tenantId: string) {
    const cacheKey = `schema:${jobId}:current`;
    if (this.cache) {
      return this.cache.getOrFetch(cacheKey, () => this._findLatestFromDb(jobId, tenantId), 30);
    }
    return this._findLatestFromDb(jobId, tenantId);
  }

  private async _findLatestFromDb(jobId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(schemasTable)
        .where(and(eq(schemasTable.jobId, jobId), eq(schemasTable.tenantId, tenantId)))
        .orderBy(desc(schemasTable.version))
        .limit(1);

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find latest schema: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByVersion(jobId: string, tenantId: string, version: number) {
    try {
      const [row] = await this.db
        .select()
        .from(schemasTable)
        .where(
          and(
            eq(schemasTable.jobId, jobId),
            eq(schemasTable.tenantId, tenantId),
            eq(schemasTable.version, version),
          ),
        );

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find schema version: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, version },
      });
    }
  }

  async findAllVersions(jobId: string, tenantId: string) {
    try {
      return await this.db
        .select()
        .from(schemasTable)
        .where(and(eq(schemasTable.jobId, jobId), eq(schemasTable.tenantId, tenantId)))
        .orderBy(desc(schemasTable.version));
    } catch (error) {
      throw new StorageError(`Failed to list schema versions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }
}
