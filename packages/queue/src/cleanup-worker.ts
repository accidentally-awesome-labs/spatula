import { sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import type { ContentStore } from '@spatula/core';

const logger = createLogger('cleanup-worker');

const DEFAULT_RETENTION = {
  completedJobsDays: 90,
  failedJobsDays: 30,
  rawPagesDays: 30,
  exportsDays: 30,
};

const SYSTEM_RETENTION = {
  auditLogDays: 365,
  llmUsageDays: 365,
  dlqResolvedDays: 90,
};

const BATCH_SIZE = 100;

/** Duck-typed deps to avoid cross-package import of concrete classes */
export interface CleanupDeps {
  db: {
    execute(query: any): Promise<{ rows: any[]; rowCount: number }>;
  };
  tenantRepo: {
    findAll(options?: { limit?: number; offset?: number }): Promise<Array<{
      id: string;
      config: Record<string, unknown>;
    }>>;
  };
  contentStore?: ContentStore;
}

export interface CleanupResult {
  tenantsProcessed: number;
  errors: number;
  systemCleanup: Record<string, number>;
}

/**
 * Daily cleanup job — three phases:
 *
 * Phase A (per-tenant): Sub-job resource cleanup
 *   Delete raw pages (+ extractions) and exports independently of job lifecycle.
 *
 * Phase B (per-tenant): Expired job cascade
 *   Delete completed/failed jobs past retention, with full FK-safe cascade.
 *
 * Phase C (global): System-wide cleanup
 *   Audit logs (365d), LLM usage (365d), resolved DLQ (90d),
 *   content store orphan scan.
 */
export async function processCleanupJob(deps: CleanupDeps): Promise<CleanupResult> {
  logger.info('Starting daily cleanup');
  const result: CleanupResult = { tenantsProcessed: 0, errors: 0, systemCleanup: {} };

  // Phases A + B: Per-tenant cleanup
  let offset = 0;
  const limit = 50;
  let tenants: Array<{ id: string; config: Record<string, unknown> }>;

  do {
    tenants = await deps.tenantRepo.findAll({ limit, offset });
    for (const tenant of tenants) {
      try {
        await cleanupTenantPhaseA(deps, tenant);
        await cleanupTenantPhaseB(deps, tenant);
      } catch (err) {
        logger.error({ tenantId: tenant.id, error: (err as Error).message }, 'Tenant cleanup failed');
        result.errors++;
      }
      result.tenantsProcessed++;
    }
    offset += limit;
  } while (tenants.length === limit);

  // Phase C: System-wide cleanup
  try {
    result.systemCleanup = await cleanupSystemData(deps);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'System cleanup failed');
    result.errors++;
  }

  logger.info(result, 'Daily cleanup complete');
  return result;
}

/**
 * Phase A: Sub-job resource cleanup.
 * FK-safe order:
 *   1. Delete extractions referencing expired raw pages
 *   2. Delete expired raw pages
 *   3. Collect content refs from expired exports
 *   4. Delete expired exports
 *   5. Clean up content store refs
 */
async function cleanupTenantPhaseA(
  deps: CleanupDeps,
  tenant: { id: string; config: Record<string, unknown> },
): Promise<void> {
  const retention = {
    ...DEFAULT_RETENTION,
    ...((tenant.config?.retention as Record<string, number>) ?? {}),
  };
  const tenantId = tenant.id;
  const rawPagesCutoff = daysAgo(retention.rawPagesDays);
  const exportsCutoff = daysAgo(retention.exportsDays);

  // A1. Delete extractions referencing expired raw pages
  await deps.db.execute(sql`
    DELETE FROM extractions WHERE id IN (
      SELECT e.id FROM extractions e
      JOIN raw_pages rp ON e.page_id = rp.id
      WHERE rp.tenant_id = ${tenantId} AND rp.created_at < ${rawPagesCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A2. Delete expired raw pages
  await deps.db.execute(sql`
    DELETE FROM raw_pages WHERE id IN (
      SELECT id FROM raw_pages
      WHERE tenant_id = ${tenantId} AND created_at < ${rawPagesCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A3. Collect content refs from expired exports
  const expiredExports = await deps.db.execute(sql`
    SELECT content_ref FROM exports
    WHERE tenant_id = ${tenantId} AND created_at < ${exportsCutoff}
    AND content_ref IS NOT NULL
    LIMIT ${BATCH_SIZE}
  `);
  const contentRefs: string[] = (expiredExports.rows ?? [])
    .map((r: any) => r.content_ref)
    .filter(Boolean);

  // A4. Delete expired exports
  await deps.db.execute(sql`
    DELETE FROM exports WHERE id IN (
      SELECT id FROM exports
      WHERE tenant_id = ${tenantId} AND created_at < ${exportsCutoff}
      LIMIT ${BATCH_SIZE}
    )
  `);

  // A5. Content store cleanup
  if (deps.contentStore && contentRefs.length > 0) {
    for (const ref of contentRefs) {
      try { await deps.contentStore.delete(ref); } catch (err) {
        logger.warn({ ref, error: (err as Error).message }, 'Failed to delete content store entry');
      }
    }
  }

  logger.debug({ tenantId, rawPagesCutoff, exportsCutoff }, 'Phase A complete');
}

/**
 * Phase B: Expired job cascade.
 * FK chain: entity_sources -> entities -> extractions -> raw_pages ->
 *   crawl_tasks -> actions -> source_trust -> schemas -> exports -> job
 */
async function cleanupTenantPhaseB(
  deps: CleanupDeps,
  tenant: { id: string; config: Record<string, unknown> },
): Promise<void> {
  const retention = {
    ...DEFAULT_RETENTION,
    ...((tenant.config?.retention as Record<string, number>) ?? {}),
  };
  const tenantId = tenant.id;
  const completedCutoff = daysAgo(retention.completedJobsDays);
  const failedCutoff = daysAgo(retention.failedJobsDays);

  const expiredJobs = await deps.db.execute(sql`
    SELECT id FROM jobs WHERE tenant_id = ${tenantId} AND (
      (status = 'completed' AND completed_at < ${completedCutoff})
      OR (status = 'failed' AND completed_at < ${failedCutoff})
    ) LIMIT ${BATCH_SIZE}
  `);
  const jobIds: string[] = (expiredJobs.rows ?? []).map((r: any) => r.id);
  if (jobIds.length === 0) return;

  logger.info({ tenantId, expiredJobCount: jobIds.length }, 'Deleting expired jobs');

  for (const jobId of jobIds) {
    try {
      // B1. Break circular FK
      await deps.db.execute(sql`UPDATE jobs SET schema_id = NULL WHERE id = ${jobId}`);
      // B2. Delete entity_sources
      await deps.db.execute(sql`
        DELETE FROM entity_sources WHERE entity_id IN (
          SELECT id FROM entities WHERE job_id = ${jobId}
        )
      `);
      // B3. Delete entities
      await deps.db.execute(sql`DELETE FROM entities WHERE job_id = ${jobId}`);
      // B4. Delete extractions
      await deps.db.execute(sql`
        DELETE FROM extractions WHERE page_id IN (
          SELECT rp.id FROM raw_pages rp
          JOIN crawl_tasks ct ON rp.task_id = ct.id
          WHERE ct.job_id = ${jobId}
        )
      `);
      // B5. Delete raw_pages
      await deps.db.execute(sql`
        DELETE FROM raw_pages WHERE task_id IN (
          SELECT id FROM crawl_tasks WHERE job_id = ${jobId}
        )
      `);
      // B6. Delete crawl_tasks
      await deps.db.execute(sql`DELETE FROM crawl_tasks WHERE job_id = ${jobId}`);
      // B7. Delete actions
      await deps.db.execute(sql`DELETE FROM actions WHERE job_id = ${jobId}`);
      // B8. Delete source_trust
      await deps.db.execute(sql`DELETE FROM source_trust WHERE job_id = ${jobId}`);
      // B9. Delete schemas
      await deps.db.execute(sql`DELETE FROM schemas WHERE job_id = ${jobId}`);
      // B10. Delete exports
      await deps.db.execute(sql`DELETE FROM exports WHERE job_id = ${jobId}`);
      // B11. Delete the job (llm_usage.job_id and dlq.spatula_job_id are ON DELETE SET NULL)
      await deps.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);
    } catch (err) {
      logger.error({ tenantId, jobId, error: (err as Error).message }, 'Failed to delete expired job');
    }
  }

  logger.debug({ tenantId, deletedJobs: jobIds.length }, 'Phase B complete');
}

/**
 * Phase C: System-wide cleanup + content store orphan scan.
 */
async function cleanupSystemData(deps: CleanupDeps): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};

  const auditCutoff = daysAgo(SYSTEM_RETENTION.auditLogDays);
  const auditResult = await deps.db.execute(sql`
    DELETE FROM audit_log WHERE created_at < ${auditCutoff}
  `);
  stats.auditLogs = auditResult?.rowCount ?? 0;

  const llmCutoff = daysAgo(SYSTEM_RETENTION.llmUsageDays);
  const llmResult = await deps.db.execute(sql`
    DELETE FROM llm_usage WHERE created_at < ${llmCutoff}
  `);
  stats.llmUsage = llmResult?.rowCount ?? 0;

  const dlqCutoff = daysAgo(SYSTEM_RETENTION.dlqResolvedDays);
  const dlqResult = await deps.db.execute(sql`
    DELETE FROM dead_letter_queue
    WHERE resolved_at IS NOT NULL AND resolved_at < ${dlqCutoff}
  `);
  stats.dlqResolved = dlqResult?.rowCount ?? 0;

  // Content store orphan scan
  if (deps.contentStore) {
    const orphans = await deps.db.execute(sql`
      SELECT id, key FROM content_store
      WHERE key NOT IN (
        SELECT content_ref FROM exports WHERE content_ref IS NOT NULL
        UNION ALL
        SELECT content_ref FROM raw_pages WHERE content_ref IS NOT NULL
        UNION ALL
        SELECT content_ref FROM crawl_tasks WHERE content_ref IS NOT NULL
      )
      LIMIT ${BATCH_SIZE}
    `);
    let orphanCount = 0;
    for (const row of (orphans.rows ?? [])) {
      try {
        await deps.contentStore.delete((row as any).key);
        orphanCount++;
      } catch (err) {
        logger.warn({ key: (row as any).key, error: (err as Error).message }, 'Failed to delete orphan content');
      }
    }
    stats.contentOrphans = orphanCount;
  }

  logger.info(stats, 'System cleanup complete');
  return stats;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
