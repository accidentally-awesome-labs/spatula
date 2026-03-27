import type { LLMUsageRecorder, LLMUsageRecord } from '@spatula/core';
import type { LlmUsageRepository } from '@spatula/db';
import type { SpatulaMetrics } from '@spatula/shared';
import { createLogger } from '@spatula/shared';

const logger = createLogger('usage-recorder');

export class DefaultUsageRecorder implements LLMUsageRecorder {
  constructor(
    private readonly tenantId: string,
    private readonly jobId: string | undefined,
    private readonly repo?: LlmUsageRepository,
    private readonly metrics?: SpatulaMetrics,
  ) {}

  record(usage: LLMUsageRecord): void {
    const attrs = { tenantId: this.tenantId, jobId: this.jobId ?? 'unknown', model: usage.model };

    if (this.metrics) {
      this.metrics.llmTokensUsed.add(usage.totalTokens, attrs);
      this.metrics.llmCostUsd.add(usage.costUsd, attrs);
      this.metrics.llmRequestDuration.record(usage.durationMs, attrs);
    }

    if (this.repo) {
      this.repo.insert({
        tenantId: this.tenantId,
        jobId: this.jobId,
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd.toFixed(6),
        purpose: usage.purpose ?? 'unknown',
      }).catch((err) => {
        logger.warn({ err, model: usage.model }, 'Failed to record LLM usage');
      });
    }
  }
}
