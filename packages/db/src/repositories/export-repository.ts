import { eq, and, desc, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@accidentally-awesome-labs/spatula-shared';
import { exports } from '../schema/exports.js';
import type { Database } from '../connection.js';

const logger = createLogger('export-repository');

export interface CreateExportInput {
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite';
  includeProvenance: boolean;
}

export class ExportRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateExportInput) {
    try {
      const [row] = await this.db
        .insert(exports)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          format: input.format,
          includeProvenance: input.includeProvenance,
          updatedAt: new Date(),
        })
        .returning();
      logger.debug({ exportId: row.id }, 'export created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId },
      });
    }
  }

  async findById(exportId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(exports)
        .where(and(eq(exports.id, exportId), eq(exports.tenantId, tenantId)));
      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { exportId },
      });
    }
  }

  async findByJob(jobId: string, tenantId: string, options?: { limit?: number; offset?: number }) {
    try {
      let query = this.db
        .select()
        .from(exports)
        .where(and(eq(exports.jobId, jobId), eq(exports.tenantId, tenantId)))
        .orderBy(desc(exports.createdAt));

      if (options?.limit !== undefined) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find exports: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
  ) {
    try {
      const conditions = [eq(exports.jobId, jobId), eq(exports.tenantId, tenantId)];
      if (cursor) conditions.push(sql`${exports.id} > ${cursor}::uuid`);
      if (since) conditions.push(sql`${exports.updatedAt} > ${since}`);

      const rows = await this.db
        .select()
        .from(exports)
        .where(and(...conditions))
        .orderBy(exports.id)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
      return { entities: rows, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to fetch exports by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }

  async countByJob(jobId: string, tenantId: string): Promise<number> {
    try {
      const [result] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(exports)
        .where(and(eq(exports.jobId, jobId), eq(exports.tenantId, tenantId)));
      return result?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count exports: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }

  async updateStatus(
    exportId: string,
    tenantId: string,
    update: {
      status: 'processing' | 'completed' | 'failed';
      entityCount?: number;
      contentRef?: string;
      fileSize?: number;
      error?: string;
      completedAt?: Date;
    },
  ) {
    try {
      const [row] = await this.db
        .update(exports)
        .set({ ...update, updatedAt: new Date() })
        .where(and(eq(exports.id, exportId), eq(exports.tenantId, tenantId)))
        .returning();
      if (!row) {
        throw new StorageError(`Export ${exportId} not found`, { context: { exportId } });
      }
      logger.debug({ exportId, status: update.status }, 'export status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { exportId },
      });
    }
  }
}
