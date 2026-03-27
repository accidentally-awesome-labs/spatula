import { eq, desc } from 'drizzle-orm';
import { StorageError } from '@spatula/shared';
import { auditLog } from '../schema/audit-log.js';
import type { Database } from '../connection.js';

export interface AuditLogEntry {
  tenantId?: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export class AuditLogRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: AuditLogEntry) {
    try {
      const [row] = await this.db
        .insert(auditLog)
        .values({
          tenantId: entry.tenantId,
          actorId: entry.actorId,
          actorType: entry.actorType,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          metadata: entry.metadata ?? {},
          ipAddress: entry.ipAddress,
        })
        .returning();
      return row;
    } catch (error) {
      throw new StorageError(`Failed to insert audit log: ${(error as Error).message}`, {
        cause: error as Error,
        context: { action: entry.action },
      });
    }
  }

  async findByTenant(tenantId: string, options?: { limit?: number; offset?: number }) {
    try {
      return await this.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantId))
        .orderBy(desc(auditLog.createdAt))
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to query audit log: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
