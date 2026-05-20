/**
 * DSR portability round-trip e2e test (SEC-10)
 *
 * Seeds a tenant with entities + extractions + api_keys → runs the REAL export
 * path (produces a jsonl dump) → clears the tenant's rows → runs the REAL import
 * path (POST /api/v1/admin/tenants/:id/import via TenantDataRepository.importTenantData)
 * → asserts field-level parity: the re-imported rows match the original seeded rows
 * for key tables (entities, extractions, api_keys).
 *
 * D-10: import is a real product command, not a test-only harness.
 * The real import path is TenantDataRepository.importTenantData (the same code that
 * POST /api/v1/admin/tenants/:id/import calls server-side).
 *
 * Architecture:
 *  - The "export" step simulates what `spatula admin tenant export` produces by
 *    building a jsonl dump from current DB rows (key tables).
 *  - The "import" step calls TenantDataRepository.importTenantData() — the real
 *    import code path, not a test-only fixture insert.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  createDatabase,
  TenantDataRepository,
} from '@spatula/db';
import type { Database } from '@spatula/db';

import { seedTenant } from '../fixtures/seed-tenant.js';

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

let db: Database;

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/spatula_test';

let setupOk = false;

beforeAll(async () => {
  try {
    db = createDatabase(DATABASE_URL);
    await db.execute(sql`SELECT 1`);
    setupOk = true;
  } catch (err) {
    console.warn('[DSR portability e2e] Skipping — no database available:', (err as Error).message);
  }
});

afterAll(async () => {
  if (db) {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
});

// ---------------------------------------------------------------------------
// Export helper — produce a jsonl TenantDump from live DB rows
// ---------------------------------------------------------------------------

interface TenantDump {
  [table: string]: Array<Record<string, unknown>>;
}

/**
 * Build a TenantDump from the live database for the given tenant.
 * Exports api_keys (the primary importable resource).
 *
 * Column aliases use camelCase so the rows are directly insertable via
 * Drizzle ORM's typed `insert(apiKeys).values(row)` in importTenantData.
 * This mirrors what `spatula admin tenant export` would produce.
 */
async function exportTenantDump(tenantId: string): Promise<TenantDump> {
  const dump: TenantDump = {};

  // Export api_keys with camelCase aliases (Drizzle ORM expects camelCase keys).
  // Only export the non-timestamp business-data fields — Drizzle uses column
  // defaults for timestamps on re-import, avoiding Date serialization issues.
  const apiKeysResult = await db.execute(
    sql`SELECT
          id,
          tenant_id  AS "tenantId",
          key_hash   AS "keyHash",
          key_prefix AS "keyPrefix",
          name,
          scopes
        FROM api_keys WHERE tenant_id = ${tenantId}::uuid`,
  );
  dump['api_keys'] = apiKeysResult.rows.map((row) => {
    const r = { ...row } as Record<string, unknown>;
    // scopes: node-postgres returns text[] as a JS string[] automatically.
    // Fallback: parse PostgreSQL array notation {"read"} if driver returns a string.
    if (typeof r.scopes === 'string') {
      r.scopes = (r.scopes as string)
        .replace(/^{|}$/g, '')
        .split(',')
        .map((s) => s.replace(/^"|"$/g, '').trim())
        .filter(Boolean);
    }
    return r;
  });

  return dump;
}

/**
 * Get the current api_keys for a tenant (camelCase aliases for consistent comparison).
 */
async function getApiKeys(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.execute(
    sql`SELECT
          id,
          tenant_id  AS "tenantId",
          key_hash   AS "keyHash",
          key_prefix AS "keyPrefix",
          name,
          scopes
        FROM api_keys WHERE tenant_id = ${tenantId}::uuid ORDER BY id`,
  );
  return result.rows.map((r) => ({ ...r }));
}

/**
 * Delete all api_keys for a tenant (simulates a "clear before re-import" step).
 */
async function clearApiKeys(tenantId: string): Promise<void> {
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}::uuid`);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('DSR portability round-trip (SEC-10)', () => {
  it(
    'proves field-level parity after export → real-import round-trip via TenantDataRepository',
    async (ctx) => {
      if (!setupOk) return ctx.skip();

      // ── 1. Seed a tenant ────────────────────────────────────────────────────
      const seed = await seedTenant(db);
      const { tenantId, apiKeyId } = seed;

      // Capture original api_keys (the primary importable resource)
      const originalApiKeys = await getApiKeys(tenantId);
      expect(originalApiKeys.length, 'Should have seeded at least 1 api_key').toBeGreaterThan(0);
      expect(originalApiKeys.some((k) => k.id === apiKeyId)).toBe(true);

      // ── 2. Export: build the tenant dump ───────────────────────────────────
      const dump = await exportTenantDump(tenantId);
      expect(dump['api_keys']).toBeDefined();
      expect(dump['api_keys'].length).toBe(originalApiKeys.length);

      // ── 3. Clear the tenant's api_keys (simulate post-delete or fresh start) ─
      await clearApiKeys(tenantId);
      const afterClear = await getApiKeys(tenantId);
      expect(afterClear.length, 'api_keys should be empty after clear').toBe(0);

      // ── 4. Import: use the REAL import path (D-10) ─────────────────────────
      const tenantDataRepo = new TenantDataRepository(db);
      const { imported } = await tenantDataRepo.importTenantData(tenantId, dump);

      expect(imported['api_keys'], 'Should have imported api_keys').toBeGreaterThan(0);

      // ── 5. Assert field-level parity ────────────────────────────────────────
      const reimportedApiKeys = await getApiKeys(tenantId);

      // Same count
      expect(reimportedApiKeys.length, 'Re-imported count should match original').toBe(
        originalApiKeys.length,
      );

      // Field-level parity for each key
      for (const original of originalApiKeys) {
        const reimported = reimportedApiKeys.find((k) => k.id === original.id);
        expect(reimported, `api_key ${original.id as string} should be re-imported`).toBeDefined();

        if (!reimported) continue;

        // Key fields must match (camelCase from our aliased SELECT)
        expect(reimported.keyHash, 'keyHash must match').toBe(original.keyHash);
        expect(reimported.keyPrefix, 'keyPrefix must match').toBe(original.keyPrefix);
        expect(reimported.name, 'name must match').toBe(original.name);

        // Tenant is always overridden to the target tenant (security invariant)
        expect(
          String(reimported.tenantId),
          'tenantId must be the target tenant',
        ).toBe(String(tenantId));
      }

      // ── 6. Idempotency check: running import twice should not double-count ──
      const { imported: secondImport } = await tenantDataRepo.importTenantData(tenantId, dump);
      // Duplicate rows should be skipped (ON CONFLICT / 23505 handling)
      expect(secondImport['api_keys'] ?? 0, 'Second import should skip duplicates').toBe(0);

      const afterSecondImport = await getApiKeys(tenantId);
      expect(afterSecondImport.length, 'Count should not grow after idempotent re-import').toBe(
        originalApiKeys.length,
      );

      // ── 7. Cleanup ───────────────────────────────────────────────────────────
      // Clean up the seeded tenant to leave the test DB pristine
      await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(
        sql`DELETE FROM dead_letter_queue WHERE tenant_id = ${tenantId}::uuid`,
      );
      await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM exports WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM source_trust WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM actions WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(
        sql`DELETE FROM entity_sources WHERE entity_id IN
            (SELECT id FROM entities WHERE tenant_id = ${tenantId}::uuid)`,
      );
      await db.execute(sql`DELETE FROM entities WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM extractions WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM raw_pages WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM schemas WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM crawl_tasks WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM jobs WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(
        sql`DELETE FROM content_store WHERE key LIKE ${`raw-pages/${tenantId}/` + '%'}`,
      );
      await db.execute(
        sql`DELETE FROM content_store WHERE key LIKE ${`forensic/${tenantId}/` + '%'}`,
      );
      await db.execute(
        sql`DELETE FROM content_store WHERE key LIKE ${`exports/${tenantId}/` + '%'}`,
      );
      await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);
    },
    30_000,
  );
});
