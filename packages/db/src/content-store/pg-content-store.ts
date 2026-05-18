import { eq } from 'drizzle-orm';
import { StorageError, createLogger } from '@spatula/shared';
import type { ContentStore } from '@spatula/core';
import { contentStore } from '../schema/content.js';
import type { Database } from '../connection.js';
import type { TenantRepository } from '../repositories/tenant-repository.js';

const logger = createLogger('pg-content-store');

export class PgContentStore implements ContentStore {
  private tenantId?: string;
  private tenantRepo?: TenantRepository;

  constructor(private readonly db: Database) {}

  setTenantContext(tenantId: string, tenantRepo: TenantRepository): void {
    this.tenantId = tenantId;
    this.tenantRepo = tenantRepo;
  }

  async store(key: string, content: string): Promise<string> {
    try {
      const [row] = await this.db
        .insert(contentStore)
        .values({ key, content })
        .onConflictDoUpdate({ target: contentStore.key, set: { content } })
        .returning();

      const ref = `pg://${row.id}`;
      logger.debug({ ref, key }, 'content stored');

      // Track storage bytes (fire-and-forget)
      if (this.tenantId && this.tenantRepo) {
        const bytes = Buffer.byteLength(content, 'utf-8');
        void this.tenantRepo
          .incrementStorageBytes(this.tenantId, bytes)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key },
      });
    }
  }

  async retrieve(ref: string): Promise<string> {
    const id = this.parseRef(ref);
    try {
      const [row] = await this.db.select().from(contentStore).where(eq(contentStore.id, id));

      if (!row || !row.content) {
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
    const id = this.parseRef(ref);
    try {
      await this.db.delete(contentStore).where(eq(contentStore.id, id));

      logger.debug({ ref }, 'content deleted');
    } catch (error) {
      throw new StorageError(`Failed to delete content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async storeBinary(key: string, data: Uint8Array): Promise<string> {
    try {
      const [row] = await this.db
        .insert(contentStore)
        .values({ key, binaryContent: data })
        .onConflictDoUpdate({ target: contentStore.key, set: { binaryContent: data } })
        .returning();

      const ref = `pg://${row.id}`;
      logger.debug({ ref, key, size: data.byteLength }, 'binary content stored');

      // Track storage bytes (fire-and-forget)
      if (this.tenantId && this.tenantRepo) {
        void this.tenantRepo
          .incrementStorageBytes(this.tenantId, data.byteLength)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store binary content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key },
      });
    }
  }

  async retrieveBinary(ref: string): Promise<Uint8Array | null> {
    const id = this.parseRef(ref);
    try {
      const [row] = await this.db.select().from(contentStore).where(eq(contentStore.id, id));
      if (!row) return null;
      return row.binaryContent ?? null;
    } catch (error) {
      throw new StorageError(`Failed to retrieve binary content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  private parseRef(ref: string): string {
    if (!ref.startsWith('pg://')) {
      throw new StorageError(`Invalid content ref format: ${ref}`, { context: { ref } });
    }
    return ref.slice(5);
  }
}
