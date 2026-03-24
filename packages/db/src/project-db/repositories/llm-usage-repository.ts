/**
 * SQLite LLM usage repository — local-only, no Postgres equivalent.
 *
 * Per-call LLM cost tracking. This is a local-only repository:
 * constructor takes only (db) with no projectId.
 */
import { eq, sql } from 'drizzle-orm';
import type { ProjectDatabase } from '../connection.js';
import { llmUsage } from '../../schema-sqlite/llm-usage.js';

export class LlmUsageRepository {
  constructor(private readonly db: ProjectDatabase) {}

  async record(data: {
    runId?: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    purpose: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.db
      .insert(llmUsage)
      .values({
        id,
        runId: data.runId ?? null,
        model: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens: data.totalTokens,
        costUsd: data.costUsd,
        purpose: data.purpose,
        createdAt: new Date().toISOString(),
      })
      .run();
    return { id };
  }

  async findByRun(runId: string): Promise<Array<{
    id: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    purpose: string;
    createdAt: string;
  }>> {
    return this.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.runId, runId))
      .all();
  }

  async aggregateByRun(runId: string): Promise<Array<{
    purpose: string;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    callCount: number;
  }>> {
    const rows = this.db
      .select({
        purpose: llmUsage.purpose,
        totalPromptTokens: sql<number>`sum(${llmUsage.promptTokens})`,
        totalCompletionTokens: sql<number>`sum(${llmUsage.completionTokens})`,
        totalTokens: sql<number>`sum(${llmUsage.totalTokens})`,
        totalCostUsd: sql<number>`sum(${llmUsage.costUsd})`,
        callCount: sql<number>`count(*)`,
      })
      .from(llmUsage)
      .where(eq(llmUsage.runId, runId))
      .groupBy(llmUsage.purpose)
      .all();

    return rows.map((row) => ({
      purpose: row.purpose,
      totalPromptTokens: Number(row.totalPromptTokens),
      totalCompletionTokens: Number(row.totalCompletionTokens),
      totalTokens: Number(row.totalTokens),
      totalCostUsd: Number(row.totalCostUsd),
      callCount: Number(row.callCount),
    }));
  }
}
