/**
 * TenantDataRepository.
 *
 * Provides three operations required for GDPR-complete DSR deletion:
 *  1. cascadeDeleteTenantData  — DELETE from every tenant-scoped table (FK-safe order)
 *  2. redactTenantAuditLog     — in-place PII redaction of audit_log rows
 *  3. insertDeletionTombstone  — one un-redacted audit_log record proving the deletion
 *
 * Does NOT delete the `tenants` row — that is the final step in the BullMQ worker.
 * All three operations are idempotent.
 */
import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import { auditLog } from '../schema/audit-log.js';
import { entitySources } from '../schema/entities.js';
import { entities } from '../schema/entities.js';
import { actions } from '../schema/actions.js';
import { extractions } from '../schema/extractions.js';
import { rawPages } from '../schema/raw-pages.js';
import { exports as exportsTable } from '../schema/exports.js';
import { crawlTasks } from '../schema/crawl-tasks.js';
import { jobs } from '../schema/jobs.js';
import { llmUsage } from '../schema/llm-usage.js';
import { apiKeys } from '../schema/api-keys.js';
import { userTenants } from '../schema/user-tenants.js';
import { sourceTrust } from '../schema/source-trust.js';
import { schemasTable } from '../schema/schemas.js';
import { deadLetterQueue } from '../schema/dead-letter-queue.js';
import type { Database } from '../connection.js';

const logger = createLogger('tenant-data-repository');

export interface TenantDump {
  api_keys?: Array<Record<string, unknown>>;
  [table: string]: Array<Record<string, unknown>> | undefined;
}

export class TenantDataRepository {
  constructor(private readonly db: Database) {}

  /**
   * Delete all data owned by a tenant across every tenant-scoped table.
   *
   * Deletion order is FK-safe (children before parents):
   *   entity_sources → entities → actions → extractions → source_trust →
   *   raw_pages → exports → schemas → crawl_tasks → jobs →
   *   llm_usage → api_keys → user_tenants → dead_letter_queue
   *
   * The `tenants` row itself is NOT deleted here — the BullMQ worker handles that last.
   * Running this twice is safe (re-running on already-empty tables is a no-op).
   */
  async cascadeDeleteTenantData(
    tenantId: string,
  ): Promise<{ deletedCounts: Record<string, number> }> {
    logger.debug({ tenantId }, 'cascadeDeleteTenantData: starting');

    const deletedCounts: Record<string, number> = {};

    const del = async (
      tableName: string,
      deleteExpr: () => Promise<{ rowCount?: number | null }>,
    ) => {
      const result = await deleteExpr();
      const count = result.rowCount ?? 0;
      deletedCounts[tableName] = count;
      if (count > 0) {
        logger.debug(
          { tenantId, table: tableName, count },
          'cascadeDeleteTenantData: deleted rows',
        );
      }
    };

    // entity_sources (FK → entities + extractions) — must come before both
    await del('entity_sources', () =>
      this.db.delete(entitySources).where(
        sql`${entitySources.entityId} IN (
            SELECT id FROM entities WHERE tenant_id = ${tenantId}::uuid
          )`,
      ),
    );

    // entities
    await del('entities', () => this.db.delete(entities).where(eq(entities.tenantId, tenantId)));

    // actions
    await del('actions', () => this.db.delete(actions).where(eq(actions.tenantId, tenantId)));

    // extractions
    await del('extractions', () =>
      this.db.delete(extractions).where(eq(extractions.tenantId, tenantId)),
    );

    // source_trust
    await del('source_trust', () =>
      this.db.delete(sourceTrust).where(eq(sourceTrust.tenantId, tenantId)),
    );

    // raw_pages
    await del('raw_pages', () => this.db.delete(rawPages).where(eq(rawPages.tenantId, tenantId)));

    // exports
    await del('exports', () =>
      this.db.delete(exportsTable).where(eq(exportsTable.tenantId, tenantId)),
    );

    // schemas
    await del('schemas', () =>
      this.db.delete(schemasTable).where(eq(schemasTable.tenantId, tenantId)),
    );

    // crawl_tasks
    await del('crawl_tasks', () =>
      this.db.delete(crawlTasks).where(eq(crawlTasks.tenantId, tenantId)),
    );

    // jobs
    await del('jobs', () => this.db.delete(jobs).where(eq(jobs.tenantId, tenantId)));

    // llm_usage (has onDelete: cascade in schema, but we delete explicitly for
    // idempotency — if llm_usage rows survived for any reason, explicit delete cleans them)
    await del('llm_usage', () => this.db.delete(llmUsage).where(eq(llmUsage.tenantId, tenantId)));

    // api_keys
    await del('api_keys', () => this.db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId)));

    // user_tenants (has onDelete: cascade, but explicit for idempotency)
    await del('user_tenants', () =>
      this.db.delete(userTenants).where(eq(userTenants.tenantId, tenantId)),
    );

    // dead_letter_queue — tenantId FK is onDelete: 'set null'; we explicitly
    // delete the rows rather than leave orphaned DLQ entries behind
    await del('dead_letter_queue', () =>
      this.db.delete(deadLetterQueue).where(eq(deadLetterQueue.tenantId, tenantId)),
    );

    logger.info({ tenantId, deletedCounts }, 'cascadeDeleteTenantData: complete');
    return { deletedCounts };
  }

  /**
   * Redact PII from all audit_log rows belonging to this tenant.
   *
   * Sets: tenant_id = NULL, metadata = {}, ip_address = NULL, actor_id = '[deleted]'
   * Does NOT delete audit rows; audit history must be preserved.
   * tenant_id is nulled so the FK constraint is cleared before the tenant row is deleted.
   * Safe to run multiple times (already-redacted rows get the same values written again).
   *
   * @returns The number of rows redacted.
   */
  async redactTenantAuditLog(tenantId: string): Promise<number> {
    const result = await this.db
      .update(auditLog)
      .set({
        tenantId: null, // Clear FK so tenant row can be deleted.
        metadata: {},
        ipAddress: null,
        actorId: '[deleted]',
      })
      .where(eq(auditLog.tenantId, tenantId));

    const count = result.rowCount ?? 0;
    logger.debug({ tenantId, count }, 'redactTenantAuditLog: complete');
    return count;
  }

  /**
   * Insert one un-redacted tombstone audit_log row proving the deletion happened.
   *
   * The tombstone row has tenantId = NULL (FK is nullable — the tenant row is
   * being deleted, so we cannot FK back to it). The resourceId column holds the
   * deleted tenant's id so the record is queryable even after the tenant is gone.
   */
  async insertDeletionTombstone(input: {
    deletedTenantId: string;
    requestedBy: string;
    requestedAt: string;
  }): Promise<void> {
    const { deletedTenantId, requestedBy, requestedAt } = input;

    await this.db.insert(auditLog).values({
      tenantId: null, // FK nullable — tenant row is being deleted
      actorId: requestedBy,
      actorType: 'system',
      action: 'tenant.deleted',
      resourceType: 'tenant',
      resourceId: deletedTenantId,
      metadata: {
        requestedAt,
        deletedAt: new Date().toISOString(),
      },
    });

    logger.info({ deletedTenantId, requestedBy }, 'insertDeletionTombstone: tombstone created');
  }

  /**
   * Import tenant data from a dump object (symmetric with the export command output).
   *
   * The dump is an object keyed by table name, with arrays of row objects.
   * Currently supports: api_keys (the primary importable resource).
   *
   * All rows are inserted with their tenantId overridden to the target tenant,
   * preventing a dump from one tenant being imported into another.
   *
   * @returns { imported: Record<string, number> } per-table insert counts.
   */
  async importTenantData(
    tenantId: string,
    dump: TenantDump,
  ): Promise<{ imported: Record<string, number> }> {
    const imported: Record<string, number> = {};

    if (dump.api_keys?.length) {
      const rows = dump.api_keys.map((row) => ({
        ...(row as any),
        tenantId, // Enforce target tenant — never trust the dump's tenant value
        id: (row as any).id ?? undefined,
      }));
      // Insert rows one by one; catch duplicate-key errors and skip (idempotent import)
      let count = 0;
      for (const row of rows) {
        try {
          await this.db.insert(apiKeys).values(row);
          count += 1;
        } catch (err: unknown) {
          // Postgres unique violation (23505) — row already exists, skip.
          // Drizzle may wrap the pg error: check both top-level code and cause.code.
          const pgCode = (err as any)?.code ?? (err as any)?.cause?.code;
          if (pgCode === '23505') continue;
          throw err;
        }
      }
      imported['api_keys'] = count;
    }

    logger.info({ tenantId, imported }, 'importTenantData: complete');
    return { imported };
  }
}
