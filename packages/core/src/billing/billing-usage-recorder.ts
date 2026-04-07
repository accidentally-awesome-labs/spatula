import { createLogger } from '@spatula/shared';
import type { LLMUsageRecorder, LLMUsageRecord } from '../interfaces/llm-client.js';
import type { QuotaEnforcer } from './quota-enforcer.js';

const logger = createLogger('billing-usage-recorder');

/**
 * Wraps an existing LLMUsageRecorder to also record token usage
 * for billing metering via QuotaEnforcer.
 *
 * Usage: wrap the existing recorder when setting up the LLM client:
 *   const billingRecorder = new BillingUsageRecorder(existingRecorder, quotaEnforcer, tenantId);
 *   llmClient.setUsageRecorder(billingRecorder);
 */
export class BillingUsageRecorder implements LLMUsageRecorder {
  constructor(
    private readonly inner: LLMUsageRecorder | undefined,
    private readonly quotaEnforcer: QuotaEnforcer,
    private readonly tenantId: string,
  ) {}

  record(usage: LLMUsageRecord): void {
    // Delegate to inner recorder (existing LLM usage tracking)
    this.inner?.record(usage);

    // Record token usage for billing metering (fire-and-forget)
    if (usage.totalTokens > 0) {
      this.quotaEnforcer.recordUsage(this.tenantId, 'llm_tokens', usage.totalTokens).catch((err) => {
        logger.warn({ err, tenantId: this.tenantId, tokens: usage.totalTokens }, 'Failed to record LLM token usage for billing');
      });
    }
  }
}
