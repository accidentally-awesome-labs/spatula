/**
 * Contract test server harness — Phase 16 plan 16-4.
 *
 * Boots the apps/api Hono app behind a Node-builtin `http.Server`, captures the
 * randomly-assigned port, and exposes a `{ url, close }` handle to the suite.
 *
 * REUSES the Node-builtin http.Server adapter pattern from
 * `tests/carveout/fixtures/server.ts` (Phase 15) so we don't introduce
 * `@hono/node-server` at the workspace root. The trade-off is ~30 lines of
 * Node-→-Fetch adapter glue, but the gain is zero workspace-dependency-
 * resolution gotchas (the adapter compiles against `node:http` + the standard
 * `Request`/`Response` globals only).
 *
 * Designed for ONE server per suite (beforeAll/afterAll), not per-test. The
 * matrix driver in generated.test.ts boots once at suite-start, fetches
 * `/api/v1/openapi.json`, and iterates the served spec across many describe
 * blocks. Per-test boots would push suite runtime past the 30s hookTimeout.
 *
 * Plan dependency note: this harness exercises the GET /api/v1/openapi.json
 * endpoint from plan 16-3 (apps/api/src/routes/openapi.ts). If 16-3's
 * mount-points are not yet committed at the time this suite runs, the matrix
 * driver in generated.test.ts will skip its dynamic discovery and rely on the
 * explicit per-REQ suites (errors / headers / deprecation / etc) instead.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../apps/api/src/app.js';
import { ApiKeyAuthProvider } from '../../../apps/api/src/auth/api-key-provider.js';
import type { AppDeps } from '../../../apps/api/src/types.js';
import { createDatabasePool, TenantRepository, ApiKeyRepository, JobRepository } from '@spatula/db';
import type { Pool } from 'pg';
import Redis from 'ioredis';

export interface ContractServer {
  /** Base URL including the auto-assigned port, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Underlying pg pool — exposed so suites can clean up seeded fixtures. */
  pool: Pool;
  /** Repos handed back so suites can seed without rebuilding the connection. */
  tenantRepo: TenantRepository;
  apiKeyRepo: ApiKeyRepository;
  /**
   * Underlying Redis client (if `enableRedis: true` was passed). Suites that
   * need to verify rate-limit headers MUST construct the server with redis;
   * the rate-limit middleware no-ops when `deps.redis` is absent.
   */
  redis: Redis | null;
  /** Shut both the listening socket and the pg pool down. */
  close(): Promise<void>;
}

export interface ContractServerOptions {
  /**
   * Postgres URL. Defaults to `process.env.TEST_DATABASE_URL` so the harness
   * works in CI (where the umbrella job exports TEST_DATABASE_URL) without
   * per-test plumbing.
   */
  databaseUrl?: string;
  /**
   * If `true`, wire an ioredis client into AppDeps so the rate-limit
   * middleware activates and emits its 4 response headers. Defaults to
   * `false` so contract suites that don't need rate-limit headers can boot
   * without a live Redis instance.
   */
  enableRedis?: boolean;
  /**
   * Redis URL. Used only when `enableRedis: true`. Defaults to
   * `process.env.REDIS_URL` then `redis://localhost:6379`.
   */
  redisUrl?: string;
}

/**
 * Boot an OSS-only apps/api server for the contract suite. Returns a handle
 * the caller closes in afterAll. Default deps satisfy the minimum the routes
 * we hit in this suite traverse: tenants, api-keys, jobs, entities,
 * /api/v1/openapi.json. Routes that need workers/exporters/etc. are not
 * exercised by the contract matrix (it validates SHAPES, not throughput).
 */
export async function startServer(options: ContractServerOptions = {}): Promise<ContractServer> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://spatula:spatula@localhost:5432/spatula_test';

  const { pool, db } = createDatabasePool(databaseUrl);

  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);

  // Optional Redis wiring for suites that need the rate-limit middleware
  // active (its headers + 429 behavior). Default-off keeps the boot fast and
  // doesn't fail when Redis isn't available.
  let redis: Redis | null = null;
  if (options.enableRedis) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });
  }

  // Minimal AppDeps — only the bits the contract suite traverses:
  //   - /api/v1/openapi.json is unauthenticated (mounted in app.ts at root)
  //   - /api/v1/auth/me uses no repo
  //   - /api/v1/admin/tenants/:id uses tenantRepo + jobRepo
  //   - the matrix driver hits live 2xx routes — those that NEED a missing
  //     repo will return 500, which the matrix correctly skips (no schema to
  //     validate against, since the dep is not present).
  const deps = {
    dbPool: pool,
    jobRepo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schemaRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractionRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entityRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entitySourceRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actionRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jobManager: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contentStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportQueue: {} as any,
    tenantRepo,
    apiKeyRepo,
    authProvider: new ApiKeyAuthProvider(apiKeyRepo),
    redis: redis ?? undefined,
  } as unknown as AppDeps;

  const app = createApp(deps);

  // Adapter: Node http.IncomingMessage → standard fetch Request → Hono → Response.
  // Carry-forward from tests/carveout/fixtures/server.ts.
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      const hasBody = !(req.method === 'GET' || req.method === 'HEAD');
      let body: Uint8Array | undefined;
      if (hasBody) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (chunks.length > 0) body = Buffer.concat(chunks);
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) headers.set(k, v.join(','));
        else headers.set(k, v);
      }

      const request = new Request(url.toString(), {
        method: req.method ?? 'GET',
        headers,
        body: body as BodyInit | undefined,
        duplex: body ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' });

      const response = await app.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'INTERNAL.ERROR',
            message: (err as Error).message,
          },
        }),
      );
    }
  });

  const port: number = await new Promise((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address() as AddressInfo | null;
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Failed to bind contract test server'));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  return {
    url: `http://127.0.0.1:${port}`,
    pool,
    tenantRepo,
    apiKeyRepo,
    redis,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      if (redis) {
        try {
          await redis.quit();
        } catch {
          // ignore — redis may already be disconnected
        }
      }
    },
  };
}

/**
 * Mint a tenant + paired API key directly via the live repos. Returns the
 * plaintext key (only chance to capture it — the DB stores only the sha256
 * hash). Default scopes give enough surface area for the contract matrix to
 * traverse the full v1 path tree (`admin` scope unlocks every authed route).
 */
export interface SeededIdentity {
  tenantId: string;
  apiKey: string; // plaintext sk_live_* token (use as Bearer)
  apiKeyId: string;
  scopes: string[];
}

export async function seedTenantAndKey(
  handle: ContractServer,
  name: string,
  options?: { scopes?: string[] },
): Promise<SeededIdentity> {
  const scopes = options?.scopes ?? ['admin'];

  const tenant = await handle.tenantRepo.create({ name });

  const random = randomBytes(24).toString('base64url');
  const raw = `sk_live_${random}`;
  const keyHash = createHash('sha256').update(raw).digest('hex');
  const keyPrefix = raw.slice(0, 12);

  const apiKey = await handle.apiKeyRepo.create({
    tenantId: tenant.id,
    keyHash,
    keyPrefix,
    name: `${name}-key`,
    scopes,
  });

  return {
    tenantId: tenant.id,
    apiKey: raw,
    apiKeyId: apiKey.id,
    scopes,
  };
}
