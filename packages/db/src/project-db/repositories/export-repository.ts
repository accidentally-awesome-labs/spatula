/**
 * SQLite export repository — local-only.
 *
 * Implements ExportRepo from @spatula/core/pipeline/types.ts.
 * The local exports table has a different shape from Postgres (no contentRef,
 * has filePath/runId), but satisfies the updateStatus interface for the
 * export orchestrator.
 *
 * This is a local-only repository: constructor takes only (db) with
 * no projectId.
 */
import { eq, desc } from 'drizzle-orm';
import type { ExportRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { exports } from '../../schema-sqlite/exports.js';

export class SqliteExportRepository implements ExportRepo {
  constructor(private readonly db: ProjectDatabase) {}

  async create(data: {
    runId?: string;
    format: string;
    filePath: string;
    includeProvenance?: boolean;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.db
      .insert(exports)
      .values({
        id,
        runId: data.runId ?? null,
        format: data.format,
        filePath: data.filePath,
        status: 'pending',
        includeProvenance: data.includeProvenance ?? false,
        createdAt: new Date().toISOString(),
      })
      .run();
    return { id };
  }

  async findAll(): Promise<Array<{
    id: string;
    runId: string | null;
    format: string;
    filePath: string;
    status: string;
    error: string | null;
    completedAt: string | null;
    entityCount: number | null;
    fileSize: number | null;
    includeProvenance: boolean | null;
    createdAt: string;
  }>> {
    return this.db
      .select()
      .from(exports)
      .orderBy(desc(exports.createdAt))
      .all();
  }

  async findById(id: string): Promise<{
    id: string;
    runId: string | null;
    format: string;
    filePath: string;
    status: string;
    error: string | null;
    completedAt: string | null;
    entityCount: number | null;
    fileSize: number | null;
    includeProvenance: boolean | null;
    createdAt: string;
  } | null> {
    const row = this.db
      .select()
      .from(exports)
      .where(eq(exports.id, id))
      .get();

    return row ?? null;
  }

  async updateStatus(
    exportId: string,
    _tenantId: string,
    data: {
      status: 'processing' | 'completed' | 'failed';
      entityCount?: number;
      contentRef?: string;
      fileSize?: number;
      error?: string;
      completedAt?: Date;
    },
  ): Promise<unknown> {
    // contentRef from the interface is ignored in local mode (we use filePath)
    const updateData: Record<string, unknown> = {
      status: data.status,
    };

    if (data.entityCount !== undefined) updateData.entityCount = data.entityCount;
    if (data.fileSize !== undefined) updateData.fileSize = data.fileSize;
    if (data.error !== undefined) updateData.error = data.error;
    if (data.completedAt !== undefined) {
      updateData.completedAt = data.completedAt instanceof Date
        ? data.completedAt.toISOString()
        : data.completedAt;
    }

    this.db
      .update(exports)
      .set(updateData)
      .where(eq(exports.id, exportId))
      .run();

    return {};
  }
}
