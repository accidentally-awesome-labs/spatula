/**
 * SQLite page repository — local project mode.
 *
 * Implements PageRepo from @spatula/core/pipeline/types.ts.
 *
 * Key differences from Postgres PageRepository:
 * - No tenantId filtering (single-user local mode)
 * - jobId auto-set from pre-bound projectId on every insert
 * - The SQLite pages table has extra columns (url, statusCode, title,
 *   classification, contentPath, needsReextraction) merged from crawl_tasks
 *   for local query convenience — the create method accepts these as optional
 * - UUIDs via crypto.randomUUID(), timestamps via new Date().toISOString()
 */
import { eq, inArray } from 'drizzle-orm';
import type { PageRepo } from '@spatula/core/pipeline/types.js';
import type { ProjectDatabase } from '../connection.js';
import { pages } from '../../schema-sqlite/pages.js';

/** Extended create input — includes base PageRepo fields plus SQLite-only columns. */
export interface CreatePageInput {
  taskId: string;
  tenantId: string;
  contentRef: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
  // SQLite-only extensions (optional)
  url?: string;
  statusCode?: number;
  title?: string;
  classification?: string;
  contentPath?: string;
  needsReextraction?: boolean;
  reextractionReason?: string;
}

export class SqlitePageRepository implements PageRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async create(data: CreatePageInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.db
      .insert(pages)
      .values({
        id,
        taskId: data.taskId,
        jobId: this.projectId,
        contentRef: data.contentRef,
        contentHash: data.contentHash,
        metadata: data.metadata ?? {},
        createdAt: new Date().toISOString(),
        // SQLite-only extensions
        ...(data.url !== undefined ? { url: data.url } : {}),
        ...(data.statusCode !== undefined ? { statusCode: data.statusCode } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.classification !== undefined ? { classification: data.classification } : {}),
        ...(data.contentPath !== undefined ? { contentPath: data.contentPath } : {}),
        ...(data.needsReextraction !== undefined ? { needsReextraction: data.needsReextraction } : {}),
        ...(data.reextractionReason !== undefined ? { reextractionReason: data.reextractionReason } : {}),
      })
      .run();
    return { id };
  }

  async findByContentHash(
    hash: string,
    _tenantId: string,
  ): Promise<{ id: string } | null> {
    const row = this.db
      .select()
      .from(pages)
      .where(eq(pages.contentHash, hash))
      .limit(1)
      .get();
    return row ?? null;
  }

  async findByIds(
    ids: string[],
    _tenantId: string,
  ): Promise<Array<{ id: string; metadata: Record<string, unknown> | null; createdAt: Date }>> {
    if (ids.length === 0) return [];

    const rows = this.db
      .select()
      .from(pages)
      .where(inArray(pages.id, ids))
      .all();

    return rows.map((row) => ({
      id: row.id,
      metadata: row.metadata,
      // The interface expects Date; SQLite stores ISO string — convert
      createdAt: new Date(row.createdAt),
    }));
  }
}
