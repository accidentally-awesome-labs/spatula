import { createLogger } from '@spatula/shared';

const logger = createLogger('metering-worker');

/** Duck-typed Stripe client interface — avoids cross-package import from apps/api */
export interface MeteringStripeClient {
  isConfigured(): boolean;
  reportUsage(customerId: string, eventName: string, value: number, idempotencyKey?: string): Promise<void>;
}

export interface MeteringDeps {
  usageRecordRepo: {
    getUnreported(limit: number): Promise<Array<{ id: string; tenantId: string; dimension: string; quantity: number }>>;
    markReported(ids: string[]): Promise<void>;
  };
  tenantRepo: {
    findById(tenantId: string): Promise<{ id: string; stripeCustomerId?: string | null; plan?: string } | null>;
  };
  stripeClient: MeteringStripeClient;
}

/** Map usage dimension to Stripe meter event name (configured in Stripe Dashboard) */
const DIMENSION_TO_METER_EVENT: Record<string, string> = {
  pages: 'spatula_pages',
  llm_tokens: 'spatula_llm_tokens',
  jobs: 'spatula_jobs',
  storage_bytes: 'spatula_storage',
};

/**
 * Process unreported usage records and report them to Stripe via Billing Meter Events.
 * Runs as an hourly BullMQ repeatable job.
 *
 * Algorithm:
 * 1. Fetch up to 1000 unreported records
 * 2. Group by tenant+dimension
 * 3. For each tenant: look up Stripe customer ID
 * 4. Report aggregated usage per dimension via meter events
 * 5. Mark records as reported
 */
export async function processMeteringJob(deps: MeteringDeps): Promise<void> {
  if (!deps.stripeClient.isConfigured()) {
    logger.debug('Stripe not configured — metering skipped');
    return;
  }

  const records = await deps.usageRecordRepo.getUnreported(1000);
  if (records.length === 0) {
    logger.debug('No unreported usage records');
    return;
  }

  logger.info({ count: records.length }, 'Processing unreported usage records');

  // Group by tenant
  const byTenant = new Map<string, typeof records>();
  for (const r of records) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  const reportedIds: string[] = [];

  for (const [tenantId, tenantRecords] of byTenant) {
    try {
      const tenant = await deps.tenantRepo.findById(tenantId);
      if (!tenant?.stripeCustomerId) {
        // No Stripe customer — mark as reported to avoid re-processing
        reportedIds.push(...tenantRecords.map((r) => r.id));
        logger.debug({ tenantId }, 'Tenant has no Stripe customer — skipping usage report');
        continue;
      }

      // Aggregate by dimension
      const byDimension = new Map<string, number>();
      for (const r of tenantRecords) {
        byDimension.set(r.dimension, (byDimension.get(r.dimension) ?? 0) + r.quantity);
      }

      // Report each dimension to Stripe via meter events
      for (const [dimension, total] of byDimension) {
        const eventName = DIMENSION_TO_METER_EVENT[dimension];
        if (!eventName) {
          logger.warn({ dimension }, 'Unknown usage dimension — no meter event mapping');
          continue;
        }
        const idempotencyKey = `${tenantId}:${dimension}:${Date.now()}`;
        await deps.stripeClient.reportUsage(tenant.stripeCustomerId, eventName, total, idempotencyKey);
        logger.info({ tenantId, dimension, total, eventName }, 'Reported usage to Stripe');
      }

      reportedIds.push(...tenantRecords.map((r) => r.id));
    } catch (err) {
      logger.error({ tenantId, error: (err as Error).message }, 'Failed to report usage for tenant');
      // Don't mark as reported — will retry next hour
    }
  }

  // Mark successfully processed records
  if (reportedIds.length > 0) {
    await deps.usageRecordRepo.markReported(reportedIds);
    logger.info({ reported: reportedIds.length, total: records.length }, 'Metering job complete');
  }
}
