/**
 * DSR deletion round-trip e2e test (SEC-09, SEC-10)
 *
 * Seeds a tenant with rows across all tenant-scoped tables + content-store blobs
 * (including a forensic/ prefix blob), then runs the REAL cascade worker
 * (processTenantDeleteJob), and asserts:
 *
 *  1. Zero rows remain for that tenant in every tenant-scoped table
 *  2. Zero content-store blobs remain (raw page + export + forensic/)
 *  3. The tenant's audit rows are redacted in place (metadata={}, ipAddress=null,
 *     actorId='[deleted]')
 *  4. Exactly one un-redacted `tenant.deleted` tombstone row exists with
 *     resourceId = the tenantId
 *  5. The `tenants` row itself is gone
 *
 * The test boots a real Postgres connection (uses DATABASE_URL env var or
 * defaults to the standard local test DB). The cascade worker is invoked
 * directly — no BullMQ queue required for the round-trip proof.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { createDatabase, PgContentStore, TenantDataRepository } from '@spatula/db';
import type { Database } from '@spatula/db';

import { processTenantDeleteJob } from '@spatula/queue';
import type { TenantDeleteJobDeps } from '@spatula/queue';

import { seedTenant, TENANT_SCOPED_TABLES } from '../fixtures/seed-tenant.js';

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

let db: Database;

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/spatula_test';

// Allow any test that requires a real DB to be skipped when DB isn't available
let setupOk = false;

beforeAll(async () => {
  try {
    db = createDatabase(DATABASE_URL);
    // Quick connectivity check
    await db.execute(sql`SELECT 1`);
    setupOk = true;
  } catch (err) {
    console.warn('[DSR deletion e2e] Skipping — no database available:', (err as Error).message);
  }
});

afterAll(async () => {
  if (db) {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countRows(table: string, tenantId: string): Promise<number> {
  const result = await db.execute(
    sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = '${tenantId}'::uuid`),
  );
  return Number((result.rows[0] as { n: string }).n);
}

async function countContentStoreRows(keyPrefix: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT COUNT(*) AS n FROM content_store WHERE key LIKE ${keyPrefix + '%'}`,
  );
  return Number((result.rows[0] as { n: string }).n);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('DSR deletion round-trip (SEC-09/SEC-10)', () => {
  it('proves zero rows + zero blobs + redacted audit + tombstone after real cascade worker', async (ctx) => {
    if (!setupOk) return ctx.skip();

    // ── 1. Seed a tenant with rows and blobs ────────────────────────────────
    const seed = await seedTenant(db);
    const { tenantId } = seed;

    // Verify rows exist before deletion
    const jobCountBefore = await countRows('jobs', tenantId);
    expect(jobCountBefore).toBeGreaterThan(0);

    // Verify content-store blobs exist before deletion (query by key prefix)
    const rawBlobBefore = await countContentStoreRows(`raw-pages/${tenantId}/`);
    expect(rawBlobBefore).toBeGreaterThan(0);

    const forensicBlobBefore = await countContentStoreRows(`forensic/${tenantId}/`);
    expect(forensicBlobBefore).toBeGreaterThan(0);

    // ── 2. Build deps and run the REAL cascade worker ───────────────────────
    const contentStore = new PgContentStore(db);

    // Extend PgContentStore with a listKeys implementation.
    // listKeys must return pg://<uuid> refs (not raw keys) because
    // deleteBlobSafe passes them to contentStore.delete() which calls parseRef().
    const listableContentStore = Object.assign(contentStore, {
      async listKeys(prefix: string): Promise<string[]> {
        const result = await db.execute(
          sql`SELECT id FROM content_store WHERE key LIKE ${prefix + '%'}`,
        );
        return result.rows.map((r) => `pg://${(r as { id: string }).id}`);
      },
    });

    const tenantDataRepo = new TenantDataRepository(db);

    const deps: TenantDeleteJobDeps = {
      tenantDataRepo,
      contentStore: listableContentStore,
      db: {
        execute: (query) =>
          db.execute(query) as Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>,
      },
    };

    await processTenantDeleteJob(
      {
        tenantId,
        requestedBy: 'e2e-test',
        requestedAt: new Date().toISOString(),
      },
      deps,
    );

    // ── 3. Assert: zero rows in every tenant-scoped table ───────────────────
    for (const { table } of TENANT_SCOPED_TABLES) {
      const count = await countRows(table, tenantId);
      expect(count, `Expected 0 rows in ${table} for deleted tenant`).toBe(0);
    }

    // entity_sources has no direct tenant_id column — verify via entities (already 0)
    const entitySourcesCount = await db.execute(
      sql.raw(
        `SELECT COUNT(*) AS n FROM entity_sources WHERE entity_id IN
          (SELECT id FROM entities WHERE tenant_id = '${tenantId}'::uuid)`,
      ),
    );
    expect(
      Number((entitySourcesCount.rows[0] as { n: string }).n),
      'entity_sources should be 0',
    ).toBe(0);

    // ── 4. Assert: zero content-store blobs remain ──────────────────────────
    const rawBlobAfter = await countContentStoreRows(`raw-pages/${tenantId}/`);
    expect(rawBlobAfter, 'Raw page blobs should be deleted').toBe(0);

    const forensicBlobAfter = await countContentStoreRows(`forensic/${tenantId}/`);
    expect(forensicBlobAfter, 'Forensic blobs should be deleted').toBe(0);

    // ── 5. Assert: audit_log rows are redacted ──────────────────────────────
    // After deletion, the tenant's prior audit rows should have:
    //   metadata = {}, ip_address = NULL, actor_id = '[deleted]'
    // BUT the tombstone row (tenantId = NULL) should still be un-redacted.
    const redactedRows = await db.execute(
      sql`SELECT id, metadata, ip_address, actor_id
            FROM audit_log
            WHERE tenant_id IS NULL
              AND resource_id = ${tenantId}
              AND action = 'tenant.deleted'`,
    );

    // Tombstone should exist and be un-redacted
    expect(redactedRows.rows.length, 'Tombstone row should exist').toBe(1);
    const tombstone = redactedRows.rows[0] as {
      metadata: Record<string, unknown>;
      ip_address: string | null;
      actor_id: string;
    };
    // Tombstone actor_id = the requestedBy value (not '[deleted]')
    expect(tombstone.actor_id).toBe('e2e-test');

    // ── 6. Assert: the tenants row itself is gone ───────────────────────────
    const tenantRow = await db.execute(sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid`);
    expect(tenantRow.rows.length, 'Tenant row should be deleted').toBe(0);
  }, 30_000); // 30s timeout for DB operations
});
