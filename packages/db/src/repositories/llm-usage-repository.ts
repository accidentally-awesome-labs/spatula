import { eq, and, gte, sql, desc } from 'drizzle-orm';
import { StorageError } from '@accidentally-awesome-labs/spatula-shared';
import { llmUsage } from '../schema/llm-usage.js';
import type { Database } from '../connection.js';

export interface LlmUsageInput {
  tenantId: string;
  jobId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
  purpose: string;
}

export interface UsageAggregation {
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number }>;
  byPurpose: Record<string, { tokens: number; costUsd: number }>;
  byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
}

export class LlmUsageRepository {
  constructor(private readonly db: Database) {}

  async insert(input: LlmUsageInput) {
    try {
      const [row] = await this.db
        .insert(llmUsage)
        .values({
          tenantId: input.tenantId,
          jobId: input.jobId,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
          costUsd: input.costUsd,
          purpose: input.purpose,
        })
        .returning();
      return row;
    } catch (error) {
      throw new StorageError(`Failed to insert LLM usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId, model: input.model },
      });
    }
  }

  async aggregateByTenant(tenantId: string, since: Date): Promise<UsageAggregation> {
    try {
      const conditions = and(eq(llmUsage.tenantId, tenantId), gte(llmUsage.createdAt, since));

      // Totals via SQL aggregation
      const [totals] = await this.db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)::int`,
          totalCostUsd: sql<number>`COALESCE(SUM(${llmUsage.costUsd}::numeric), 0)::float`,
        })
        .from(llmUsage)
        .where(conditions);

      // By model
      const modelRows = await this.db
        .select({
          model: llmUsage.model,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(conditions)
        .groupBy(llmUsage.model);

      // By purpose
      const purposeRows = await this.db
        .select({
          purpose: llmUsage.purpose,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(conditions)
        .groupBy(llmUsage.purpose);

      // By job (top 50 by cost)
      const jobRows = await this.db
        .select({
          jobId: llmUsage.jobId,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(and(conditions, sql`${llmUsage.jobId} IS NOT NULL`))
        .groupBy(llmUsage.jobId)
        .orderBy(desc(sql`SUM(${llmUsage.costUsd}::numeric)`))
        .limit(50);

      const byModel: Record<string, { tokens: number; costUsd: number }> = {};
      for (const r of modelRows) byModel[r.model] = { tokens: r.tokens, costUsd: r.costUsd };
      const byPurpose: Record<string, { tokens: number; costUsd: number }> = {};
      for (const r of purposeRows) byPurpose[r.purpose] = { tokens: r.tokens, costUsd: r.costUsd };

      return {
        totalTokens: totals?.totalTokens ?? 0,
        totalCostUsd: totals?.totalCostUsd ?? 0,
        byModel,
        byPurpose,
        byJob: jobRows.map((r) => ({ jobId: r.jobId!, tokens: r.tokens, costUsd: r.costUsd })),
      };
    } catch (error) {
      throw new StorageError(`Failed to aggregate LLM usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
