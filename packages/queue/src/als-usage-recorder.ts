// packages/queue/src/als-usage-recorder.ts
// LLMUsageRecorder implementation that reads {tenantId, jobId} from the
// active AsyncLocalStorage context rather than constructor parameters.
// This ensures each concurrent BullMQ job attributes its LLM spend to
// the correct tenant/job pair regardless of interleaving.

import type { LLMUsageRecorder, LLMUsageRecord } from '@spatula/core';
import type { LlmUsageRepository } from '@spatula/db';
import { createLogger } from '@spatula/shared';
import { currentUsageContext } from './usage-context.js';

const logger = createLogger('als-usage-recorder');

export class AlsUsageRecorder implements LLMUsageRecorder {
  constructor(private readonly repo: LlmUsageRepository) {}

  record(usage: LLMUsageRecord): void {
    const ctx = currentUsageContext();
    if (!ctx) {
      logger.warn({ model: usage.model }, 'LLM usage outside job context — skipping attribution');
      return;
    }
    this.repo
      .insert({
        tenantId: ctx.tenantId,
        jobId: ctx.jobId,
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd.toFixed(6),
        purpose: usage.purpose ?? 'unknown',
      })
      .catch((err) => logger.warn({ err, model: usage.model }, 'Failed to record LLM usage'));
  }
}
