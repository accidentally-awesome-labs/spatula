import { eq, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { tenants } from '../schema/tenants.js';
import type { Database } from '../connection.js';

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
  constructor(private readonly db: Database) {}

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
      const [row] = await this.db
        .select()
        .from(tenants)
        .where(eq(tenants.id, id));

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
}
