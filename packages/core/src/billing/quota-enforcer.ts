import { QuotaExceededError, BILLING_TIERS, getTierLimit } from '@spatula/shared';
import type { BillingTierName, UsageDimension } from '@spatula/shared';

/** Duck-typed interface to avoid cross-package dependency on @spatula/db */
export interface UsageReader {
  getCurrentUsage(tenantId: string, dimension: string): Promise<number>;
}

/** Duck-typed interface to avoid cross-package dependency on @spatula/db */
export interface UsageRecorder {
  record(tenantId: string, dimension: string, quantity: number): Promise<void>;
}

/** Duck-typed interface to avoid cross-package dependency on @spatula/db */
export interface PlanReader {
  getPlan(tenantId: string): Promise<string>;
}

export class QuotaEnforcer {
  constructor(
    private readonly usageRepo: UsageReader & UsageRecorder,
    private readonly tenantRepo: PlanReader,
  ) {}

  /**
   * Check if a tenant can use `requested` units of the given dimension.
   * Throws QuotaExceededError if the request would exceed the tier limit.
   */
  async check(tenantId: string, dimension: UsageDimension, requested: number): Promise<void> {
    const plan = await this.tenantRepo.getPlan(tenantId) as BillingTierName;
    const limit = getTierLimit(plan, dimension);

    if (limit === Infinity) return;

    const current = await this.usageRepo.getCurrentUsage(tenantId, dimension);
    if (current + requested > limit) {
      throw new QuotaExceededError(
        `Quota exceeded for ${dimension}: ${current + requested} > ${limit} (plan: ${plan})`,
        { context: { tenantId, dimension, current, requested, limit, plan } },
      );
    }
  }

  /**
   * Check quota then record usage. NOT atomic — two concurrent calls may both
   * pass the check before either records. This is acceptable because:
   * 1. Billing dimensions are soft limits (slight overage is fine)
   * 2. True atomicity would require DB-level locking (disproportionate cost)
   * 3. The metering worker reports actual usage to Stripe regardless
   */
  async checkAndRecord(tenantId: string, dimension: UsageDimension, quantity: number): Promise<void> {
    await this.check(tenantId, dimension, quantity);
    await this.usageRepo.record(tenantId, dimension, quantity);
  }

  /**
   * Check if an export format is allowed for the given tier.
   */
  isExportFormatAllowed(plan: string, format: string): boolean {
    const tier = BILLING_TIERS[plan as BillingTierName] ?? BILLING_TIERS.free;
    return tier.limits.exportFormats.includes(format);
  }
}
