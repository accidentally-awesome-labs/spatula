import { eq, sql, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@accidentally-awesome-labs/spatula-shared';
import { tenants } from '../schema/tenants.js';
import type { Database } from '../connection.js';
import type { RedisCache } from '../cache.js';

const logger = createLogger('tenant-repository');

export interface CreateTenantInput {
  name: string;
  config?: Record<string, unknown>;
}

export interface UpdateTenantInput {
  name?: string;
  config?: Record<string, unknown>;
}

export class TenantRepository {
  private cache?: RedisCache;

  constructor(private readonly db: Database) {}

  setCache(cache: RedisCache): void {
    this.cache = cache;
  }

  async create(input: CreateTenantInput) {
    try {
      const [row] = await this.db
        .insert(tenants)
        .values({
          name: input.name,
          config: input.config ?? {},
        })
        .returning();

      logger.debug({ tenantId: row.id }, 'tenant created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create tenant: ${(error as Error).message}`, {
        cause: error as Error,
        context: { name: input.name },
      });
    }
  }

  async findById(id: string) {
    try {
      const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find tenant ${id}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id },
      });
    }
  }

  async update(id: string, changes: UpdateTenantInput) {
    try {
      const updates: Record<string, unknown> = {};
      if (changes.name !== undefined) updates.name = changes.name;
      if (changes.config !== undefined) updates.config = changes.config;

      const [row] = await this.db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.id, id))
        .returning();

      if (!row) {
        throw new StorageError(`Tenant ${id} not found`, { context: { id } });
      }

      logger.debug({ tenantId: id }, 'tenant updated');

      // Invalidate cached quotas
      if (this.cache) {
        await this.cache.delete(`tenant:${id}:quotas`);
      }

      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update tenant: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id },
      });
    }
  }

  async getQuotas(tenantId: string) {
    const cacheKey = `tenant:${tenantId}:quotas`;
    if (this.cache) {
      return this.cache.getOrFetch(cacheKey, () => this._getQuotasFromDb(tenantId), 300);
    }
    return this._getQuotasFromDb(tenantId);
  }

  private async _getQuotasFromDb(tenantId: string) {
    try {
      const [row] = await this.db
        .select({ quotas: tenants.quotas })
        .from(tenants)
        .where(eq(tenants.id, tenantId));

      if (!row) {
        throw new StorageError(`Tenant ${tenantId} not found`, { context: { id: tenantId } });
      }

      return row.quotas as Record<string, unknown>;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to get quotas: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id: tenantId },
      });
    }
  }

  async incrementStorageBytes(tenantId: string, bytes: number) {
    try {
      await this.db
        .update(tenants)
        .set({ storageBytesUsed: sql`GREATEST(0, ${tenants.storageBytesUsed} + ${bytes})` })
        .where(eq(tenants.id, tenantId));
    } catch (error) {
      throw new StorageError(`Failed to update storage bytes: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, bytes },
      });
    }
  }

  async findAll(options?: { limit?: number; offset?: number }) {
    try {
      return await this.db
        .select()
        .from(tenants)
        .orderBy(desc(tenants.createdAt))
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to list tenants: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async countAll(): Promise<number> {
    try {
      const rows = await this.db.select({ count: sql<number>`count(*)::int` }).from(tenants);

      return (rows[0] as any)?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count tenants: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  async getTotalStorage(): Promise<number> {
    try {
      const [row] = await this.db
        .select({ total: sql<number>`coalesce(sum(storage_bytes_used), 0)::bigint` })
        .from(tenants);
      return Number((row as any)?.total ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to get total storage: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }
}
