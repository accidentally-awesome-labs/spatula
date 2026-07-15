/**
 * DSR test fixture — seeds a tenant with rows across all tenant-scoped tables
 * plus a content-store blob and a forensic/ blob.
 *
 * Returns the seeded tenantId and all created row IDs for assertion use.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgContentStore } from '@accidentally-awesome-labs/spatula-db';
import type { Database } from '@accidentally-awesome-labs/spatula-db';

export interface SeedResult {
  tenantId: string;
  jobId: string;
  apiKeyId: string;
  /** Content-store ref (pg://<id>) for a raw page blob */
  rawPageBlobRef: string;
  /** Content-store ref (pg://<id>) under the forensic/ key prefix */
  forensicBlobRef: string;
  /** Content-store ref (pg://<id>) for an export blob */
  exportBlobRef: string;
}

/**
 * Seed a tenant with representative rows across every tenant-scoped table:
 *  tenants, jobs, crawl_tasks, raw_pages (+ content-store blob),
 *  schemas, extractions, entities, entity_sources, actions, source_trust,
 *  exports, llm_usage, api_keys, dead_letter_queue, audit_log.
 *
 * Content-store blobs are stored via PgContentStore so that the
 * content_ref column holds real `pg://<uuid>` refs that the
 * tenant-delete worker can delete via PgContentStore.delete().
 */
export async function seedTenant(db: Database): Promise<SeedResult> {
  const tenantId = randomUUID();
  const jobId = randomUUID();
  const schemaId = randomUUID();
  const crawlTaskId = randomUUID();
  const pageId = randomUUID();
  const extractionId = randomUUID();
  const entityId = randomUUID();
  const actionId = randomUUID();
  const apiKeyId = randomUUID();
  const exportId = randomUUID();

  const contentStore = new PgContentStore(db);

  // ── tenants ────────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO tenants (id, name, config, quotas, storage_bytes_used, created_at)
        VALUES (${tenantId}::uuid, ${'DSR E2E Tenant'}, ${JSON.stringify({})}::jsonb,
                ${JSON.stringify({})}::jsonb, ${0}, NOW())`,
  );

  // ── jobs ───────────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO jobs (id, tenant_id, name, description, config, status, stats, created_at)
        VALUES (${jobId}::uuid, ${tenantId}::uuid, ${'E2E Job'}, ${'DSR test'},
                ${JSON.stringify({ seedUrls: ['https://example.com'] })}::jsonb,
                ${'completed'}::job_status,
                ${JSON.stringify({ pagesCompleted: 1 })}::jsonb, NOW())`,
  );

  // ── schemas ────────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO schemas (id, tenant_id, job_id, version, definition, created_at)
        VALUES (${schemaId}::uuid, ${tenantId}::uuid, ${jobId}::uuid, ${1},
                ${JSON.stringify({ fields: [], mode: 'discovery' })}::jsonb, NOW())`,
  );

  // ── crawl_tasks ────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO crawl_tasks (id, job_id, tenant_id, url, depth, status, created_at)
        VALUES (${crawlTaskId}::uuid, ${jobId}::uuid, ${tenantId}::uuid,
                ${'https://example.com'}, ${0}, ${'completed'}::crawl_task_status, NOW())`,
  );

  // ── content_store: raw page blob (stored via PgContentStore → pg://<uuid> ref) ──
  const rawPageBlobRef = await contentStore.store(
    `raw-pages/${tenantId}/${pageId}.html`,
    '<html>test</html>',
  );

  // ── raw_pages ──────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO raw_pages (id, task_id, tenant_id, content_ref, content_hash, metadata, created_at)
        VALUES (${pageId}::uuid, ${crawlTaskId}::uuid, ${tenantId}::uuid,
                ${rawPageBlobRef}, ${'sha256_test_hash'},
                ${JSON.stringify({ url: 'https://example.com' })}::jsonb, NOW())`,
  );

  // ── extractions ────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO extractions (id, job_id, tenant_id, page_id, schema_version, data,
                                  metadata, created_at, updated_at)
        VALUES (${extractionId}::uuid, ${jobId}::uuid, ${tenantId}::uuid, ${pageId}::uuid,
                ${1},
                ${JSON.stringify({ name: 'Widget A', price: 9.99 })}::jsonb,
                ${JSON.stringify({ confidence: 0.95, modelUsed: 'mock' })}::jsonb,
                NOW(), NOW())`,
  );

  // ── entities ───────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO entities (id, job_id, tenant_id, merged_data, provenance, categories,
                               quality_score, created_at, updated_at)
        VALUES (${entityId}::uuid, ${jobId}::uuid, ${tenantId}::uuid,
                ${JSON.stringify({ name: 'Widget A', price: 9.99 })}::jsonb,
                ${JSON.stringify({})}::jsonb,
                ARRAY[]::text[],
                ${0.95}, NOW(), NOW())`,
  );

  // ── entity_sources (PK is (entity_id, extraction_id); no id column) ──────
  await db.execute(
    sql`INSERT INTO entity_sources (entity_id, extraction_id, match_confidence)
        VALUES (${entityId}::uuid, ${extractionId}::uuid, ${0.95})`,
  );

  // ── source_trust ───────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO source_trust (id, job_id, tenant_id, domain, trust_level, reasoning)
        VALUES (${randomUUID()}::uuid, ${jobId}::uuid, ${tenantId}::uuid, ${'example.com'},
                ${'high'}::trust_level, ${'Consistent data'})`,
  );

  // ── actions ────────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO actions (id, job_id, tenant_id, type, payload, source, status, confidence,
                              reasoning, created_at, updated_at)
        VALUES (${actionId}::uuid, ${jobId}::uuid, ${tenantId}::uuid, ${'add_field'},
                ${JSON.stringify({ field: { name: 'color', type: 'string' } })}::jsonb,
                ${'schema_evolution'}::action_source,
                ${'pending_review'}::action_status,
                ${0.9}, ${'Reasoning'}, NOW(), NOW())`,
  );

  // ── content_store: export blob ─────────────────────────────────────────────
  const exportBlobRef = await contentStore.store(
    `exports/${tenantId}/${exportId}.jsonl`,
    '{"name":"Widget A"}',
  );

  // ── exports ────────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO exports (id, job_id, tenant_id, format, status, entity_count,
                              content_ref, created_at, updated_at)
        VALUES (${exportId}::uuid, ${jobId}::uuid, ${tenantId}::uuid, ${'jsonl'},
                ${'completed'}, ${1}, ${exportBlobRef}, NOW(), NOW())`,
  );

  // ── llm_usage ──────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO llm_usage (id, tenant_id, job_id, model, purpose, prompt_tokens,
                                completion_tokens, total_tokens, cost_usd, created_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${jobId}::uuid, ${'mock-model'},
                ${'extraction'}, ${100}, ${50}, ${150}, ${0.001}, NOW())`,
  );

  // ── api_keys (scopes is text[]) ────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, name, scopes, created_at)
        VALUES (${apiKeyId}::uuid, ${tenantId}::uuid, ${'sha256_hash_test_' + apiKeyId},
                ${'sk_li'}, ${'Test Key'}, ARRAY['read']::text[], NOW())`,
  );

  // ── dead_letter_queue ──────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO dead_letter_queue (id, queue_name, job_id, tenant_id, payload, attempts, failed_at)
        VALUES (${randomUUID()}::uuid, ${'extraction'}, ${'bullmq-job-1'}, ${tenantId}::uuid,
                ${JSON.stringify({ url: 'https://example.com' })}::jsonb, ${1}, NOW())`,
  );

  // ── audit_log ──────────────────────────────────────────────────────────────
  await db.execute(
    sql`INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, action, resource_type,
                                resource_id, metadata, ip_address, created_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${'user-abc'}, ${'user'},
                ${'api_key.created'}, ${'api_key'}, ${apiKeyId},
                ${JSON.stringify({ keyName: 'Test Key' })}::jsonb,
                ${'1.2.3.4'}, NOW())`,
  );

  // ── content_store: forensic blob ──────────────────────────────────────────
  const forensicBlobRef = await contentStore.store(
    `forensic/${tenantId}/extraction-${extractionId}.json`,
    JSON.stringify({ tenantId, extraction: { suspicious: true } }),
  );

  return {
    tenantId,
    jobId,
    apiKeyId,
    rawPageBlobRef,
    forensicBlobRef,
    exportBlobRef,
  };
}

/**
 * List all tenant-scoped tables alongside the SQL column to filter on.
 * Used for asserting zero rows remain after deletion.
 */
export const TENANT_SCOPED_TABLES = [
  { table: 'jobs', column: 'tenant_id' },
  { table: 'crawl_tasks', column: 'tenant_id' },
  { table: 'raw_pages', column: 'tenant_id' },
  { table: 'extractions', column: 'tenant_id' },
  { table: 'entities', column: 'tenant_id' },
  { table: 'actions', column: 'tenant_id' },
  { table: 'source_trust', column: 'tenant_id' },
  { table: 'exports', column: 'tenant_id' },
  { table: 'schemas', column: 'tenant_id' },
  { table: 'api_keys', column: 'tenant_id' },
  { table: 'llm_usage', column: 'tenant_id' },
  { table: 'dead_letter_queue', column: 'tenant_id' },
] as const;
