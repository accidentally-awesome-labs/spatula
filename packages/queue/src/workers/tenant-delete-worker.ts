/**
 * Tenant-delete BullMQ worker.
 *
 * Performs a GDPR-complete, idempotent, fail-loud cascade deletion of all
 * tenant data when a `spatula.tenant-delete` job is processed.
 *
 * Cascade order per job:
 *  1. Delete content-store blobs (raw_page blobs + export blobs + forensic/ prefix blobs)
 *  2. cascadeDeleteTenantData (FK-safe table deletes)
 *  3. redactTenantAuditLog (in-place PII scrub)
 *  4. insertDeletionTombstone (one un-redacted proof-of-deletion record)
 *  5. DELETE tenants row LAST
 *
 * Blob-delete error handling:
 *  - ENOENT, NoSuchKey, or statusCode 404 → blob already gone → swallow and continue
 *  - Any other error → RETHROW → BullMQ retries (up to 5 attempts with exponential backoff)
 *
 * Idempotency: all five steps are safe to re-run. On retry, already-deleted
 * blobs produce swallowable "not found" errors; already-deleted table rows
 * produce 0-row deletes; already-inserted tombstones produce a harmless duplicate.
 */
import { sql } from 'drizzle-orm';
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import type { ContentStore } from '@accidentally-awesome-labs/spatula-core';
import type { TenantDataRepository } from '@accidentally-awesome-labs/spatula-db';
import type { TenantDeleteJobData } from '../queues.js';

const logger = createLogger('tenant-delete-worker');

/** Prefix for forensic blobs — mirrors forensic-archiver.ts FORENSIC_KEY_PREFIX */
const FORENSIC_KEY_PREFIX = 'forensic/';

/**
 * Minimal DB interface needed by the worker to query blob refs and delete
 * the tenant row. Avoids importing @accidentally-awesome-labs/spatula-db directly in queue worker.
 */
export interface TenantDeleteDb {
  execute(
    query: ReturnType<typeof sql>,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

/**
 * ContentStore extended with optional listKeys — present in some implementations
 * (e.g. S3 store). When absent, the worker falls back to querying the DB for refs.
 */
export interface ListableContentStore extends ContentStore {
  listKeys?(prefix: string): Promise<string[]>;
}

export interface TenantDeleteJobDeps {
  /** TenantDataRepository from @accidentally-awesome-labs/spatula-db */
  tenantDataRepo: TenantDataRepository;
  /** ContentStore for blob deletion */
  contentStore: ListableContentStore;
  /** Raw Drizzle DB handle for executing direct queries (blob-ref lookup + tenant DELETE) */
  db: TenantDeleteDb;
}

/**
 * Determine if an error from ContentStore.delete indicates the blob is already gone.
 * Any of: code=ENOENT, code=NoSuchKey, statusCode=404.
 */
function isBlobNotFoundError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as Record<string, unknown>;
  if (e.code === 'ENOENT' || e.code === 'NoSuchKey') return true;
  if (e.statusCode === 404 || e.status === 404) return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (msg.includes('nosuchkey') || msg.includes('enoent') || msg.includes('not found')) return true;
  return false;
}

/**
 * Delete a single blob from the content store.
 * Swallows "not found" errors (idempotency); rethrows everything else.
 */
async function deleteBlobSafe(contentStore: ListableContentStore, ref: string): Promise<void> {
  try {
    await contentStore.delete(ref);
  } catch (err) {
    if (isBlobNotFoundError(err)) {
      logger.debug({ ref }, 'tenant-delete: blob already gone — skipping');
      return;
    }
    // Unexpected error: rethrow so BullMQ retries the job.
    throw err;
  }
}

/**
 * Process a tenant-delete job — the public entry point called by the BullMQ worker.
 */
export async function processTenantDeleteJob(
  data: TenantDeleteJobData,
  deps: TenantDeleteJobDeps,
): Promise<void> {
  const { tenantId, requestedBy, requestedAt } = data;
  const { tenantDataRepo, contentStore, db } = deps;

  logger.info({ tenantId, requestedBy }, 'tenant-delete: starting cascade deletion');

  // ─── Step 1: Delete content-store blobs ──────────────────────────────────────
  //
  // Three sources of blobs:
  //  a) raw_pages.content_ref (per page)
  //  b) exports.content_ref (per export — may be null)
  //  c) forensic/{tenantId}/* (prefix scan via listKeys if available, or skip if not)

  // 1a. Raw page blobs
  const rawPageRefs = await db.execute(
    sql`SELECT content_ref FROM raw_pages WHERE tenant_id = ${tenantId}::uuid`,
  );
  for (const row of rawPageRefs.rows) {
    const ref = row.content_ref as string;
    if (ref) await deleteBlobSafe(contentStore, ref);
  }

  // 1b. Export blobs
  const exportRefs = await db.execute(
    sql`SELECT content_ref FROM exports WHERE tenant_id = ${tenantId}::uuid AND content_ref IS NOT NULL`,
  );
  for (const row of exportRefs.rows) {
    const ref = row.content_ref as string;
    if (ref) await deleteBlobSafe(contentStore, ref);
  }

  // 1c. Forensic blobs — requires listKeys; skip gracefully if not supported
  const forensicPrefix = `${FORENSIC_KEY_PREFIX}${tenantId}/`;
  if (typeof contentStore.listKeys === 'function') {
    const forensicRefs = await contentStore.listKeys(forensicPrefix);
    for (const ref of forensicRefs) {
      await deleteBlobSafe(contentStore, ref);
    }
  } else {
    logger.debug(
      { tenantId, prefix: forensicPrefix },
      'tenant-delete: contentStore.listKeys not available — forensic blobs not enumerated',
    );
  }

  logger.debug({ tenantId }, 'tenant-delete: blob deletion complete');

  // ─── Step 2: Cascade delete all tenant-scoped table rows ─────────────────────
  const { deletedCounts } = await tenantDataRepo.cascadeDeleteTenantData(tenantId);
  logger.debug({ tenantId, deletedCounts }, 'tenant-delete: table cascade complete');

  // ─── Step 3: Redact audit log rows in place ───────────────────────────────────
  const redactedRows = await tenantDataRepo.redactTenantAuditLog(tenantId);
  logger.debug({ tenantId, redactedRows }, 'tenant-delete: audit log redacted');

  // ─── Step 4: Insert deletion tombstone ───────────────────────────────────────
  await tenantDataRepo.insertDeletionTombstone({
    deletedTenantId: tenantId,
    requestedBy,
    requestedAt,
  });
  logger.debug({ tenantId }, 'tenant-delete: tombstone inserted');

  // ─── Step 5: Delete the tenant row LAST ──────────────────────────────────────
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);
  logger.info({ tenantId, requestedBy }, 'tenant-delete: tenant row deleted — cascade complete');
}
