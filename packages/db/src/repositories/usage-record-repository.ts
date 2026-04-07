import { eq, and, sql, gte, lte, inArray } from 'drizzle-orm';
import { StorageError } from '@spatula/shared';
import { usageRecords } from '../schema/usage-records.js';
import type { Database } from '../connection.js';

export interface UsageRecord {
  id: string;
  tenantId: string;
  dimension: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
  reportedToStripe: boolean;
  createdAt: Date;
}

export interface DimensionUsage {
  dimension: string;
  total: number;
}

/**
 * Get the current billing period boundaries (1st of month to 1st of next month).
 */
function getCurrentPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export class UsageRecordRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record usage for a tenant+dimension in the current billing period.
   * Inserts a new row per recording event (not upsert — multiple rows per period
   * allows granular Stripe reporting and audit trail).
   */
  async record(tenantId: string, dimension: string, quantity: number): Promise<void> {
    const { start, end } = getCurrentPeriod();
    try {
      await this.db.insert(usageRecords).values({
        tenantId,
        dimension,
        quantity,
        periodStart: start,
        periodEnd: end,
      });
    } catch (error) {
      throw new StorageError(`Failed to record usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, dimension, quantity },
      });
    }
  }

  /**
   * Get total usage for a tenant+dimension in the current billing period.
   */
  async getCurrentUsage(tenantId: string, dimension: string): Promise<number> {
    const { start } = getCurrentPeriod();
    try {
      const [row] = await this.db
        .select({ total: sql<number>`COALESCE(SUM(${usageRecords.quantity}), 0)` })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            eq(usageRecords.dimension, dimension),
            eq(usageRecords.periodStart, start),
          ),
        );
      return Number(row?.total ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to get current usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, dimension },
      });
    }
  }

  /**
   * Fetch unreported records for Stripe metering (oldest first).
   */
  async getUnreported(limit: number): Promise<UsageRecord[]> {
    try {
      const rows = await this.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.reportedToStripe, false))
        .orderBy(usageRecords.createdAt)
        .limit(limit);
      return rows as unknown as UsageRecord[];
    } catch (error) {
      throw new StorageError(`Failed to get unreported usage: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Mark records as reported to Stripe.
   */
  async markReported(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.db
        .update(usageRecords)
        .set({ reportedToStripe: true })
        .where(inArray(usageRecords.id, ids));
    } catch (error) {
      throw new StorageError(`Failed to mark usage as reported: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ids },
      });
    }
  }

  /**
   * Aggregate usage by dimension for a tenant within a date range.
   */
  async aggregateByTenant(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<DimensionUsage[]> {
    try {
      const rows = await this.db
        .select({
          dimension: usageRecords.dimension,
          total: sql<number>`COALESCE(SUM(${usageRecords.quantity}), 0)`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            gte(usageRecords.periodStart, startDate.toISOString().slice(0, 10)),
            lte(usageRecords.periodEnd, endDate.toISOString().slice(0, 10)),
          ),
        )
        .groupBy(usageRecords.dimension);
      return rows.map((r) => ({ dimension: r.dimension, total: Number(r.total) }));
    } catch (error) {
      throw new StorageError(`Failed to aggregate usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
