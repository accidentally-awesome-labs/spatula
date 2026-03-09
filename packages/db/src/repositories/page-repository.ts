import { eq } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { rawPages } from '../schema/raw-pages.js';
import type { Database } from '../connection.js';

const logger = createLogger('page-repository');

export interface CreatePageInput {
  taskId: string;
  tenantId: string;
  contentRef: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
}

export class PageRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreatePageInput) {
    try {
      const [row] = await this.db
        .insert(rawPages)
        .values({
          taskId: input.taskId,
          tenantId: input.tenantId,
          contentRef: input.contentRef,
          contentHash: input.contentHash,
          metadata: input.metadata ?? {},
        })
        .returning();

      logger.debug({ pageId: row.id, taskId: input.taskId }, 'page created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { taskId: input.taskId },
      });
    }
  }

  async findByContentHash(contentHash: string) {
    try {
      const [row] = await this.db
        .select()
        .from(rawPages)
        .where(eq(rawPages.contentHash, contentHash));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find page by hash: ${(error as Error).message}`, {
        cause: error as Error,
        context: { contentHash },
      });
    }
  }

  async findByTask(taskId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(rawPages)
        .where(eq(rawPages.taskId, taskId));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { taskId },
      });
    }
  }
}
