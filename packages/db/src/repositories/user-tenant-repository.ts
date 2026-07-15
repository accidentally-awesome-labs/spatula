import { eq, and } from 'drizzle-orm';
import { createLogger, StorageError } from '@accidentally-awesome-labs/spatula-shared';
import { userTenants } from '../schema/user-tenants.js';
import type { Database } from '../connection.js';

const logger = createLogger('user-tenant-repository');

export interface UserTenantEntry {
  tenantId: string;
  role: string;
  createdAt: Date;
}

export interface TenantUserEntry {
  userId: string;
  role: string;
  createdAt: Date;
}

export class UserTenantRepository {
  constructor(private readonly db: Database) {}

  async create(userId: string, tenantId: string, role: string): Promise<void> {
    try {
      await this.db.insert(userTenants).values({ userId, tenantId, role }).onConflictDoNothing();
    } catch (error) {
      logger.error({ error, userId, tenantId }, 'Failed to create user-tenant relationship');
      throw new StorageError('Failed to create user-tenant relationship', {
        cause: error as Error,
      });
    }
  }

  async findByUserId(userId: string): Promise<UserTenantEntry[]> {
    try {
      return await this.db
        .select({
          tenantId: userTenants.tenantId,
          role: userTenants.role,
          createdAt: userTenants.createdAt,
        })
        .from(userTenants)
        .where(eq(userTenants.userId, userId));
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find tenants for user');
      throw new StorageError('Failed to find tenants for user', { cause: error as Error });
    }
  }

  async findByTenantId(tenantId: string): Promise<TenantUserEntry[]> {
    try {
      return await this.db
        .select({
          userId: userTenants.userId,
          role: userTenants.role,
          createdAt: userTenants.createdAt,
        })
        .from(userTenants)
        .where(eq(userTenants.tenantId, tenantId));
    } catch (error) {
      logger.error({ error, tenantId }, 'Failed to find users for tenant');
      throw new StorageError('Failed to find users for tenant', { cause: error as Error });
    }
  }

  async updateRole(userId: string, tenantId: string, role: string): Promise<void> {
    try {
      await this.db
        .update(userTenants)
        .set({ role })
        .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
    } catch (error) {
      logger.error({ error, userId, tenantId, role }, 'Failed to update role');
      throw new StorageError('Failed to update user-tenant role', { cause: error as Error });
    }
  }

  async remove(userId: string, tenantId: string): Promise<void> {
    try {
      await this.db
        .delete(userTenants)
        .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
    } catch (error) {
      logger.error({ error, userId, tenantId }, 'Failed to remove user-tenant relationship');
      throw new StorageError('Failed to remove user-tenant relationship', {
        cause: error as Error,
      });
    }
  }

  async isAdmin(userId: string, tenantId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));
      if (rows.length === 0) return false;
      return rows[0].role === 'owner' || rows[0].role === 'admin';
    } catch (error) {
      logger.error({ error, userId, tenantId }, 'Failed to check admin status');
      throw new StorageError('Failed to check admin status', { cause: error as Error });
    }
  }
}
