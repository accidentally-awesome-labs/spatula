import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
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

  async findByJob(jobId: string, tenantId: string) {
    try {
      return await this.db
        .select()
        .from(exports)
        .where(and(eq(exports.jobId, jobId), eq(exports.tenantId, tenantId)))
        .orderBy(desc(exports.createdAt));
    } catch (error) {
      throw new StorageError(`Failed to find exports: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
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
        .set(update)
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
