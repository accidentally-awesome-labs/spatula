import { eq, isNull, desc, and, sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import { StorageError } from '@spatula/shared';
import { deadLetterQueue } from '../schema/dead-letter-queue.js';
import type { Database } from '../connection.js';

const logger = createLogger('dlq-repository');

export interface DlqInsertInput {
  queueName: string;
  jobId: string;
  tenantId?: string;
  spatulaJobId?: string;
  payload: unknown;
  errorMessage?: string;
  errorStack?: string;
  attempts: number;
}

export class DlqRepository {
  constructor(private readonly db: Database) {}

  async insert(input: DlqInsertInput): Promise<{ id: string }> {
    try {
      const [row] = await this.db.insert(deadLetterQueue).values({
        queueName: input.queueName,
        jobId: input.jobId,
        tenantId: input.tenantId,
        spatulaJobId: input.spatulaJobId,
        payload: input.payload,  // JSONB — Drizzle handles serialization
        errorMessage: input.errorMessage,
        errorStack: input.errorStack,
        attempts: input.attempts,
      }).returning();
      logger.info({ dlqId: row.id, queueName: input.queueName, jobId: input.jobId }, 'Job moved to DLQ');
      return { id: row.id };
    } catch (error) {
      throw new StorageError('Failed to insert DLQ entry', {
        cause: error as Error,
        context: { queueName: input.queueName, jobId: input.jobId },
      });
    }
  }

  async findUnresolved(options?: {
    queueName?: string;
    tenantId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<typeof deadLetterQueue.$inferSelect>> {
    // Build conditions array to avoid double .where() (which overwrites)
    const conditions = [isNull(deadLetterQueue.resolvedAt)];
    if (options?.queueName) {
      conditions.push(eq(deadLetterQueue.queueName, options.queueName));
    }
    if (options?.tenantId) {
      conditions.push(eq(deadLetterQueue.tenantId, options.tenantId));
    }

    return this.db.select().from(deadLetterQueue)
      .where(and(...conditions))
      .orderBy(desc(deadLetterQueue.failedAt))
      .limit(options?.limit ?? 50)
      .offset(options?.offset ?? 0);
  }

  async findById(id: string, tenantId?: string): Promise<typeof deadLetterQueue.$inferSelect | null> {
    const conditions = [eq(deadLetterQueue.id, id)];
    if (tenantId) {
      conditions.push(eq(deadLetterQueue.tenantId, tenantId));
    }
    const rows = await this.db.select().from(deadLetterQueue)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ?? null;
  }

  async resolve(
    id: string,
    resolution: 'retried' | 'discarded' | 'fixed',
  ): Promise<typeof deadLetterQueue.$inferSelect> {
    const [row] = await this.db.update(deadLetterQueue)
      .set({
        resolvedAt: new Date(),
        resolution,
      })
      .where(and(eq(deadLetterQueue.id, id), isNull(deadLetterQueue.resolvedAt)))
      .returning();

    if (!row) throw new StorageError('DLQ entry not found or already resolved', { context: { id } });
    logger.info({ dlqId: id, resolution }, 'DLQ entry resolved');
    return row;
  }

  async countUnresolved(queueName?: string, tenantId?: string): Promise<number> {
    const conditions = [isNull(deadLetterQueue.resolvedAt)];
    if (queueName) conditions.push(eq(deadLetterQueue.queueName, queueName));
    if (tenantId) conditions.push(eq(deadLetterQueue.tenantId, tenantId));

    const [{ value }] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(deadLetterQueue)
      .where(and(...conditions));
    return Number(value);
  }
}
