/**
 * Isolation suite fixture seeder — Phase 17 plan 17-07.
 *
 * `seedTenantWithResources` creates a tenant + admin-scoped API key + one
 * resource per resource type reachable via authed routes. Called twice to
 * produce tenant A and tenant B so the cross-tenant matrix can assert that
 * tenant-B credentials never reveal tenant-A data.
 *
 * Extends the `seedTenantAndKey` pattern from tests/contract/helpers/server-harness.ts
 * (same pool approach — repos instantiated from the server pool via the
 * contract harness's ContractServer handle).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  JobRepository,
  EntityRepository,
  ApiKeyRepository,
  TenantRepository,
  createDatabasePool,
} from '@spatula/db';
import type { Pool } from 'pg';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * IDs of one resource per resource type seeded under this tenant.
 * These are plugged into cross-tenant path templates by the generator.
 */
export interface SeededResources {
  /** Top-level crawl job — also serves as parent for entities. */
  jobId: string;
  /** One entity nested under jobId. */
  entityId: string;
  /** The primary API key id (the one used for bearerToken above). */
  apiKeyId: string;
}

export interface SeededTenant {
  tenantId: string;
  /** Plaintext `sk_live_*` bearer token — only time it's visible. */
  bearerToken: string;
  apiKeyId: string;
  scopes: string[];
  resources: SeededResources;
  /** Short label passed at seed time (e.g. 'tenant-a', 'tenant-b'). */
  label: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(24).toString('base64url');
  const raw = `sk_live_${random}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

// ─── Main seeder ────────────────────────────────────────────────────────────

/**
 * Seed a tenant + admin-scoped API key + one resource per resource type.
 *
 * @param pool  Live pg Pool (from startServer() in the contract harness)
 * @param label Short label used in resource names (e.g. 'tenant-a')
 */
export async function seedTenantWithResources(pool: Pool, label: string): Promise<SeededTenant> {
  // Build a Drizzle db handle on top of the existing pg.Pool (no new connection).
  // createDatabasePool without an argument reads DATABASE_URL from env, but here
  // we need to wrap an existing Pool. We do this by using the internal drizzle
  // import that the repo layer uses — same pattern as createDatabase() in db/connection.ts.
  // We can't call createDatabasePool(pool) because it only accepts a URL string.
  // Instead, we get the databaseUrl from the pool's options and create a shared
  // Drizzle instance via createDatabasePool.
  //
  // HOWEVER: to avoid duplicate pool overhead, we pass the database URL and let
  // createDatabasePool make a fresh (small) pool for seeding only. The seeder
  // runs once in beforeAll so connection count is not a concern.
  const dbUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://spatula:spatula@localhost:5432/spatula_test';

  const { db, pool: ownPool } = createDatabasePool(dbUrl);

  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);
  const entityRepo = new EntityRepository(db);

  try {
    // 1. Create tenant
    const tenant = await tenantRepo.create({
      name: `isolation-${label}-${randomBytes(4).toString('hex')}`,
    });

    // 2. Create admin-scoped API key (full surface area — 'admin' covers all routes)
    const { raw, hash, prefix } = generateApiKey();
    const apiKey = await apiKeyRepo.create({
      tenantId: tenant.id,
      keyHash: hash,
      keyPrefix: prefix,
      name: `${label}-admin-key`,
      scopes: ['admin'],
    });

    // 3. Create one job (top-level resource + parent for entities/extractions)
    const job = await jobRepo.create({
      tenantId: tenant.id,
      name: `${label}-seed-job`,
      description: 'isolation suite seed job',
      // Minimal valid config that passes DB insert (full validation is server-side).
      config: {
        seedUrls: ['https://example.com'],
        maxPages: 1,
        llm: { model: 'gpt-4o-mini', temperature: 0 },
        schema: { fields: [] },
        crawlerType: 'firecrawl',
      } as any,
    });

    // 4. Create one entity nested under the job (child resource — requires parent jobId)
    const entity = await entityRepo.create({
      jobId: job.id,
      tenantId: tenant.id,
      mergedData: { name: `${label}-entity` },
      provenance: { source: 'isolation-seed' },
      categories: ['seed'],
      qualityScore: 1.0,
    });

    return {
      tenantId: tenant.id,
      bearerToken: raw,
      apiKeyId: apiKey.id,
      scopes: ['admin'],
      label,
      resources: {
        jobId: job.id,
        entityId: entity.id,
        apiKeyId: apiKey.id,
      },
    };
  } finally {
    // Close the seeder-only pool — the main server pool stays open.
    await ownPool.end();
  }
}
