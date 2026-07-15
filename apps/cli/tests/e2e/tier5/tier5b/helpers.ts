import { createHash, randomBytes } from 'node:crypto';
import { createTestApp, createTenant, type TestRepos } from '../../tier4/helpers.js';
import { apiKeys, type Database } from '@accidentally-awesome-labs/spatula-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthTestContext {
  app: any;
  pool: any;
  db: Database;
  redis: any;
  repos: TestRepos;
  tenantId: string;
  adminKey: string;
  adminKeyId: string;
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// API Key helpers
// ---------------------------------------------------------------------------

/**
 * Insert an API key directly into the database, bypassing the API.
 * Used to bootstrap the first admin key (chicken-and-egg).
 */
export async function createApiKeyDirectly(
  db: Database,
  tenantId: string,
  scopes: string[],
  name = 'test-key',
): Promise<{ rawKey: string; keyId: string }> {
  const random = randomBytes(24).toString('base64url');
  const raw = `sk_live_${random}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);

  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId,
      keyHash: hash,
      keyPrefix: prefix,
      name,
      scopes,
    })
    .returning({ id: apiKeys.id });

  return { rawKey: raw, keyId: row.id };
}

/**
 * Bearer auth headers for API key authentication.
 */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Minimal valid job body for POST /api/v1/jobs.
 */
export function minimalJobBody(overrides?: Record<string, unknown>) {
  return {
    name: 'Test Job',
    description: 'Created by tier-5b test',
    seedUrls: ['https://example.com'],
    crawl: { maxDepth: 1, maxPages: 10, concurrency: 1, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'test/model' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Context setup
// ---------------------------------------------------------------------------

/**
 * Create a test app with API key auth, a tenant, and an admin key.
 * Returns null if DATABASE_URL is not set (tests skip gracefully).
 */
export async function setupAuthContext(): Promise<AuthTestContext | null> {
  const result = await createTestApp({ authStrategy: 'api-key' });
  if (!result) return null;

  const { tenantId } = await createTenant(result.app);
  const { rawKey, keyId } = await createApiKeyDirectly(
    result.db,
    tenantId,
    ['admin'],
    'test-admin',
  );

  return {
    app: result.app,
    pool: result.pool,
    db: result.db,
    redis: result.redis,
    repos: result.repos,
    tenantId,
    adminKey: rawKey,
    adminKeyId: keyId,
    cleanup: result.cleanup,
  };
}

/**
 * Create two isolated tenants (A and B), each with their own admin API key.
 * Returns ctx (tenant A context) and tenantB info.
 */
export async function setupTenantPair(): Promise<{
  ctx: AuthTestContext;
  tenantB: { tenantId: string; key: string };
} | null> {
  const ctx = await setupAuthContext();
  if (!ctx) return null;

  const { tenantId: tenantBId } = await createTenant(ctx.app, 'Tenant B');
  const { rawKey } = await createApiKeyDirectly(ctx.db, tenantBId, ['admin'], 'tenant-b-admin');

  return {
    ctx,
    tenantB: { tenantId: tenantBId, key: rawKey },
  };
}
