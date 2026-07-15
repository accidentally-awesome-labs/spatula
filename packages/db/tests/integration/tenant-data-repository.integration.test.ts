/**
 * Integration tests for TenantDataRepository against real Postgres.
 *
 * Requires: TEST_DATABASE_URL pointing to a Postgres instance.
 * Migrations are applied once for the whole package via
 * tests/setup/global-migrate.ts (wired through vitest.config.ts).
 *
 * Run: pnpm --filter @accidentally-awesome-labs/spatula-db exec vitest run tests/integration/tenant-data-repository.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDatabasePool, type DatabasePool } from '../../src/connection.js';
import { TenantRepository } from '../../src/repositories/tenant-repository.js';
import { TenantDataRepository } from '../../src/repositories/tenant-data-repository.js';
import { AuditLogRepository } from '../../src/repositories/audit-log-repository.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://spatula:spatula@localhost:5432/spatula_test';
const INTEGRATION_TEST_TIMEOUT = 30_000;

let dbPool: DatabasePool;
let tenantRepo: TenantRepository;
let tenantDataRepo: TenantDataRepository;
let auditLogRepo: AuditLogRepository;

// Track created tenant IDs that survive the test (for outer cleanup)
const survivingTenantIds: string[] = [];

beforeAll(() => {
  dbPool = createDatabasePool(TEST_DB_URL);
  tenantRepo = new TenantRepository(dbPool.db);
  tenantDataRepo = new TenantDataRepository(dbPool.db);
  auditLogRepo = new AuditLogRepository(dbPool.db);
});

afterAll(async () => {
  // Best-effort cleanup for any surviving tenants (tombstone rows have null tenantId — safe)
  for (const tid of survivingTenantIds) {
    await dbPool.db.execute(sql`DELETE FROM tenants WHERE id = ${tid}::uuid`).catch(() => {});
  }
  await dbPool.pool.end();
});

async function createTestTenant(name: string): Promise<string> {
  const tenant = await tenantRepo.create({ name: `${name}-${randomUUID()}` });
  return tenant.id;
}

/**
 * Seeds rows in several tenant-scoped tables so cascade has real data to delete.
 * Returns the job id + some row ids for later assertions.
 */
async function seedTenantData(tenantId: string) {
  // db.execute returns a QueryResult; access .rows on it
  const jobResult = await dbPool.db.execute(sql`
    INSERT INTO jobs (tenant_id, name, description, config, status)
    VALUES (
      ${tenantId}::uuid,
      'test-job',
      'desc',
      '{"seeds":[],"outputDescription":"","outputFormat":"json"}'::jsonb,
      'pending'
    )
    RETURNING id
  `);
  const jobId = (jobResult as any).rows[0].id as string;

  // Insert a schema referencing that job
  await dbPool.db.execute(sql`
    INSERT INTO schemas (job_id, tenant_id, version, definition)
    VALUES (
      ${jobId}::uuid,
      ${tenantId}::uuid,
      1,
      '{"fields":[]}'::jsonb
    )
  `);

  // Insert a crawl task
  const ctResult = await dbPool.db.execute(sql`
    INSERT INTO crawl_tasks (job_id, tenant_id, url)
    VALUES (${jobId}::uuid, ${tenantId}::uuid, 'https://example.com')
    RETURNING id
  `);
  const taskId = (ctResult as any).rows[0].id as string;

  // Insert a raw_page
  const rpResult = await dbPool.db.execute(sql`
    INSERT INTO raw_pages (task_id, tenant_id, content_ref, content_hash)
    VALUES (${taskId}::uuid, ${tenantId}::uuid, 'ref://test', 'abc123')
    RETURNING id
  `);
  const pageId = (rpResult as any).rows[0].id as string;

  // Insert an extraction
  const extResult = await dbPool.db.execute(sql`
    INSERT INTO extractions (job_id, tenant_id, page_id, schema_version, data, metadata)
    VALUES (
      ${jobId}::uuid,
      ${tenantId}::uuid,
      ${pageId}::uuid,
      1,
      '{}'::jsonb,
      '{}'::jsonb
    )
    RETURNING id
  `);
  const extractionId = (extResult as any).rows[0].id as string;

  // Insert an entity (no entity_sources to avoid FK complexity)
  await dbPool.db.execute(sql`
    INSERT INTO entities (job_id, tenant_id, merged_data, provenance, categories, quality_score)
    VALUES (
      ${jobId}::uuid,
      ${tenantId}::uuid,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::text[],
      0.8
    )
  `);

  // Insert source_trust (trust_level enum: authoritative | high | medium | low)
  await dbPool.db.execute(sql`
    INSERT INTO source_trust (job_id, tenant_id, domain, trust_level, reasoning)
    VALUES (${jobId}::uuid, ${tenantId}::uuid, 'example.com', 'high', 'test')
  `);

  return { jobId, taskId, pageId, extractionId };
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const result = await dbPool.db.execute(
    sql.raw(`SELECT COUNT(*)::int AS cnt FROM ${table} WHERE tenant_id = '${tenantId}'`),
  );
  return (result as any).rows[0].cnt as number;
}

describe('TenantDataRepository (integration)', () => {
  describe('cascadeDeleteTenantData', () => {
    it(
      'deletes all tenant-scoped rows and returns per-table counts',
      async () => {
        const tenantId = await createTestTenant('cascade-test');
        // Keep this tenant for outer cleanup only if cascade fails
        survivingTenantIds.push(tenantId);

        await seedTenantData(tenantId);

        // Verify rows exist
        expect(await countRows('jobs', tenantId)).toBeGreaterThan(0);
        expect(await countRows('crawl_tasks', tenantId)).toBeGreaterThan(0);
        expect(await countRows('raw_pages', tenantId)).toBeGreaterThan(0);
        expect(await countRows('extractions', tenantId)).toBeGreaterThan(0);

        const result = await tenantDataRepo.cascadeDeleteTenantData(tenantId);

        // All counts should now be 0
        expect(await countRows('jobs', tenantId)).toBe(0);
        expect(await countRows('crawl_tasks', tenantId)).toBe(0);
        expect(await countRows('raw_pages', tenantId)).toBe(0);
        expect(await countRows('extractions', tenantId)).toBe(0);
        expect(await countRows('entities', tenantId)).toBe(0);

        // deletedCounts is a map of table names to row counts
        expect(result.deletedCounts).toBeDefined();
        expect(typeof result.deletedCounts).toBe('object');
      },
      INTEGRATION_TEST_TIMEOUT,
    );

    it(
      'is idempotent — running cascade twice does not throw',
      async () => {
        const tenantId = await createTestTenant('cascade-idempotent');
        survivingTenantIds.push(tenantId);

        await seedTenantData(tenantId);

        // First run
        await tenantDataRepo.cascadeDeleteTenantData(tenantId);

        // Second run — must NOT throw
        await expect(tenantDataRepo.cascadeDeleteTenantData(tenantId)).resolves.not.toThrow();
      },
      INTEGRATION_TEST_TIMEOUT,
    );

    it('does NOT delete the tenants row itself', async () => {
      const tenantId = await createTestTenant('cascade-no-tenant-row');
      survivingTenantIds.push(tenantId);

      await tenantDataRepo.cascadeDeleteTenantData(tenantId);

      const tenantCheck = await dbPool.db.execute(
        sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid`,
      );
      expect((tenantCheck as any).rows).toHaveLength(1);
    });
  });

  describe('redactTenantAuditLog', () => {
    it('redacts PII fields in audit_log rows for the tenant', async () => {
      const tenantId = await createTestTenant('redact-test');
      survivingTenantIds.push(tenantId);

      // Insert some audit rows
      await auditLogRepo.insert({
        tenantId,
        actorId: 'user-abc',
        actorType: 'user',
        action: 'test.action',
        metadata: { secret: 'sensitive' },
        ipAddress: '1.2.3.4',
      });
      await auditLogRepo.insert({
        tenantId,
        actorId: 'user-xyz',
        actorType: 'api_key',
        action: 'test.another',
        ipAddress: '5.6.7.8',
      });

      const redactedCount = await tenantDataRepo.redactTenantAuditLog(tenantId);

      expect(redactedCount).toBe(2);

      // Check the rows are redacted
      const rows = await auditLogRepo.findByTenant(tenantId, { limit: 10 });
      for (const row of rows) {
        expect(row.actorId).toBe('[deleted]');
        expect(row.ipAddress).toBeNull();
        expect(row.metadata).toEqual({});
      }
    });

    it('returns 0 when no audit rows for tenant', async () => {
      const tenantId = await createTestTenant('redact-empty');
      survivingTenantIds.push(tenantId);

      const count = await tenantDataRepo.redactTenantAuditLog(tenantId);
      expect(count).toBe(0);
    });
  });

  describe('insertDeletionTombstone', () => {
    it('inserts a single un-redacted tombstone row with correct fields', async () => {
      const deletedTenantId = randomUUID(); // Use a random id — tenant row may not exist
      const requestedBy = 'admin-user';
      const requestedAt = new Date().toISOString();

      await tenantDataRepo.insertDeletionTombstone({ deletedTenantId, requestedBy, requestedAt });

      // Query directly — tombstone has tenantId = null
      const result = await dbPool.db.execute(sql`
        SELECT action, actor_id, actor_type, resource_type, resource_id, metadata, tenant_id
        FROM audit_log
        WHERE action = 'tenant.deleted'
          AND resource_id = ${deletedTenantId}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const row = (result as any).rows[0];
      expect(row).toBeDefined();
      expect(row.action).toBe('tenant.deleted');
      expect(row.actor_type).toBe('system');
      expect(row.resource_type).toBe('tenant');
      expect(row.resource_id).toBe(deletedTenantId);
      expect(row.tenant_id).toBeNull();
      expect(row.metadata.requestedAt).toBe(requestedAt);
      expect(row.metadata.deletedAt).toBeDefined();
    });
  });

  describe('importTenantData', () => {
    it('imports tenant data and returns per-table counts', async () => {
      const tenantId = await createTestTenant('import-test');
      survivingTenantIds.push(tenantId);

      // Import a minimal dump: just api_keys (no complex FK chain needed)
      // Use randomized keyHash to avoid collision with prior test runs in shared DB
      const keyHash = `hash-${randomUUID()}`;
      const dump = {
        api_keys: [
          {
            id: randomUUID(),
            tenantId,
            keyHash,
            keyPrefix: 'sk-ab',
            name: 'imported-key',
            scopes: ['jobs:read'],
          },
        ],
      };

      const result = await tenantDataRepo.importTenantData(tenantId, dump);

      expect(result.imported).toBeDefined();
      expect(result.imported['api_keys']).toBe(1);

      // Verify it was actually inserted
      const rows = await dbPool.db.execute(
        sql`SELECT id FROM api_keys WHERE tenant_id = ${tenantId}::uuid`,
      );
      expect((rows as any).rows).toHaveLength(1);
    });
  });
});
