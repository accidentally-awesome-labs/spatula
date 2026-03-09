import { eq } from 'drizzle-orm';
import { StorageError, createLogger } from '@spatula/shared';
import type { ContentStore } from '@spatula/core';
import { contentStore } from '../schema/content.js';
import type { Database } from '../connection.js';

const logger = createLogger('pg-content-store');

export class PgContentStore implements ContentStore {
  constructor(private readonly db: Database) {}

  async store(key: string, content: string): Promise<string> {
    try {
      const [row] = await this.db
        .insert(contentStore)
        .values({ key, content })
        .returning();

      const ref = `pg://${row.id}`;
      logger.debug({ ref, key }, 'content stored');
      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key },
      });
    }
  }

  async retrieve(ref: string): Promise<string> {
    const id = ref.replace('pg://', '');
    try {
      const [row] = await this.db
        .select()
        .from(contentStore)
        .where(eq(contentStore.id, id));

      if (!row) {
        throw new StorageError(`Content not found: ${ref}`, { context: { ref } });
      }

      return row.content;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to retrieve content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async delete(ref: string): Promise<void> {
    const id = ref.replace('pg://', '');
    try {
      await this.db
        .delete(contentStore)
        .where(eq(contentStore.id, id));

      logger.debug({ ref }, 'content deleted');
    } catch (error) {
      throw new StorageError(`Failed to delete content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }
}
