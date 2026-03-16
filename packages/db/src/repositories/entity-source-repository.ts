import { eq } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { entitySources } from '../schema/entities.js';
import { extractions } from '../schema/extractions.js';
import { rawPages } from '../schema/raw-pages.js';
import { crawlTasks } from '../schema/crawl-tasks.js';
import type { Database } from '../connection.js';

const logger = createLogger('entity-source-repository');

export class EntitySourceRepository {
  constructor(private readonly db: Database) {}

  async link(entityId: string, extractionId: string, matchConfidence: number) {
    try {
      const [row] = await this.db
        .insert(entitySources)
        .values({ entityId, extractionId, matchConfidence })
        .returning();

      logger.debug({ entityId, extractionId, matchConfidence }, 'entity source linked');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to link entity source: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId, extractionId },
      });
    }
  }

  async bulkLink(
    links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
  ) {
    if (links.length === 0) {
      return [];
    }

    try {
      const rows = await this.db.insert(entitySources).values(links).returning();

      logger.debug({ count: rows.length }, 'entity sources bulk linked');
      return rows;
    } catch (error) {
      throw new StorageError(`Failed to bulk link entity sources: ${(error as Error).message}`, {
        cause: error as Error,
        context: { count: links.length },
      });
    }
  }

  async findByEntity(entityId: string) {
    try {
      return await this.db.select().from(entitySources).where(eq(entitySources.entityId, entityId));
    } catch (error) {
      throw new StorageError(`Failed to find entity sources: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId },
      });
    }
  }

  async findByEntityWithUrls(entityId: string) {
    try {
      const rows = await this.db
        .select({
          extractionId: entitySources.extractionId,
          matchConfidence: entitySources.matchConfidence,
          sourceUrl: crawlTasks.url,
        })
        .from(entitySources)
        .innerJoin(extractions, eq(entitySources.extractionId, extractions.id))
        .innerJoin(rawPages, eq(extractions.pageId, rawPages.id))
        .innerJoin(crawlTasks, eq(rawPages.taskId, crawlTasks.id))
        .where(eq(entitySources.entityId, entityId));
      return rows;
    } catch (error) {
      throw new StorageError(`Failed to find entity sources with URLs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { entityId },
      });
    }
  }
}
