import { eq, and, desc, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@accidentally-awesome-labs/spatula-shared';
import { extractions } from '../schema/extractions.js';
import { rawPages } from '../schema/raw-pages.js';
import { crawlTasks } from '../schema/crawl-tasks.js';
import type { Database } from '../connection.js';

const logger = createLogger('extraction-repository');

export interface StoreExtractionInput {
  jobId: string;
  tenantId: string;
  pageId: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  unmappedFields: unknown[];
  metadata: Record<string, unknown>;
}

export class ExtractionRepository {
  constructor(private readonly db: Database) {}

  async store(input: StoreExtractionInput) {
    try {
      const [row] = await this.db
        .insert(extractions)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          pageId: input.pageId,
          schemaVersion: input.schemaVersion,
          data: input.data,
          unmappedFields: input.unmappedFields,
          metadata: input.metadata,
          updatedAt: new Date(),
        })
        .returning();

      logger.debug({ extractionId: row.id, pageId: input.pageId }, 'extraction stored');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to store extraction: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, pageId: input.pageId },
      });
    }
  }

  async findByJob(
    jobId: string,
    tenantId: string,
    options?: { schemaVersion?: number; limit?: number; offset?: number },
  ) {
    try {
      const conditions = [eq(extractions.jobId, jobId), eq(extractions.tenantId, tenantId)];
      if (options?.schemaVersion !== undefined) {
        conditions.push(eq(extractions.schemaVersion, options.schemaVersion));
      }

      let query = this.db
        .select({
          id: extractions.id,
          jobId: extractions.jobId,
          tenantId: extractions.tenantId,
          pageId: extractions.pageId,
          pageUrl: crawlTasks.url,
          schemaVersion: extractions.schemaVersion,
          data: extractions.data,
          unmappedFields: extractions.unmappedFields,
          metadata: extractions.metadata,
          createdAt: extractions.createdAt,
        })
        .from(extractions)
        .leftJoin(rawPages, eq(extractions.pageId, rawPages.id))
        .leftJoin(crawlTasks, eq(rawPages.taskId, crawlTasks.id))
        .where(and(...conditions))
        .orderBy(desc(extractions.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find extractions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async countByJob(
    jobId: string,
    tenantId: string,
    options?: { schemaVersion?: number },
  ): Promise<number> {
    try {
      const conditions = [eq(extractions.jobId, jobId), eq(extractions.tenantId, tenantId)];
      if (options?.schemaVersion !== undefined) {
        conditions.push(eq(extractions.schemaVersion, options.schemaVersion));
      }

      const [result] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(extractions)
        .where(and(...conditions));

      return result?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count extractions: ${(error as Error).message}`, {
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
      const conditions = [eq(extractions.jobId, jobId), eq(extractions.tenantId, tenantId)];
      if (cursor) conditions.push(sql`${extractions.id} > ${cursor}::uuid`);
      if (since) conditions.push(sql`${extractions.updatedAt} > ${since}`);

      const rows = await this.db
        .select({
          id: extractions.id,
          jobId: extractions.jobId,
          tenantId: extractions.tenantId,
          pageId: extractions.pageId,
          pageUrl: crawlTasks.url,
          schemaVersion: extractions.schemaVersion,
          data: extractions.data,
          unmappedFields: extractions.unmappedFields,
          metadata: extractions.metadata,
          createdAt: extractions.createdAt,
        })
        .from(extractions)
        .leftJoin(rawPages, eq(extractions.pageId, rawPages.id))
        .leftJoin(crawlTasks, eq(rawPages.taskId, crawlTasks.id))
        .where(and(...conditions))
        .orderBy(extractions.id)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
      return { entities: rows, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to fetch extractions by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }

  async findByPage(pageId: string, tenantId: string) {
    try {
      return await this.db
        .select()
        .from(extractions)
        .where(and(eq(extractions.pageId, pageId), eq(extractions.tenantId, tenantId)))
        .orderBy(desc(extractions.createdAt));
    } catch (error) {
      throw new StorageError(`Failed to find extractions for page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { pageId },
      });
    }
  }
}
