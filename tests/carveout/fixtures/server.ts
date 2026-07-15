import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../../../apps/api/src/app.js';
import { ApiKeyAuthProvider } from '../../../apps/api/src/auth/api-key-provider.js';
import type { AppDeps } from '../../../apps/api/src/types.js';
import {
  createDatabasePool,
  TenantRepository,
  ApiKeyRepository,
  JobRepository,
} from '@accidentally-awesome-labs/spatula-db';
import type { Pool } from 'pg';

export interface ForwardTestHandle {
  server: Server;
  pool: Pool;
  port: number;
  baseUrl: string;
  tenantRepo: TenantRepository;
  apiKeyRepo: ApiKeyRepository;
  close(): Promise<void>;
}

export interface SeededIdentity {
  tenantId: string;
  apiKey: string; // plaintext sk_live_* token (use as Bearer)
  apiKeyId: string; // for cleanup
  scopes: string[];
}

/**
 * Boot an OSS-only API server against a real Postgres URL. The server uses
 * the api-key auth strategy so we can mint a real key for the seeded tenant
 * and exercise the post-carve `/auth/me` + `/admin/tenants/:id` routes.
 *
 * Implementation note: we use Node's built-in `http.createServer` (not
 * `@hono/node-server`) so the fixture has zero workspace-dependency-resolution
 * gotchas when run from the repo-root `tests/carveout/` location. Hono's
 * `app.fetch` accepts a standard `Request` and returns a standard `Response`,
 * so the adapter below is straightforward.
 *
 * The returned handle owns the underlying pg.Pool and the listening socket;
 * `close()` shuts both down. Designed for one-server-per-suite usage
 * (beforeAll / afterAll), not per-test.
 */
export async function startCarveoutServer(databaseUrl: string): Promise<ForwardTestHandle> {
  const { pool, db } = createDatabasePool(databaseUrl);

  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);

  // Minimal AppDeps — only the bits the forward tests actually traverse:
  //   /auth/me uses no repo (just c.get('auth') from middleware)
  //   /admin/tenants/:id uses tenantRepo + jobRepo
  //   /api/openapi.json is unauthenticated
  const deps = {
    dbPool: pool,
    jobRepo,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo,
    apiKeyRepo,
    authProvider: new ApiKeyAuthProvider(apiKeyRepo),
  } as unknown as AppDeps;

  const app = createApp(deps);

  // Adapter: Node http.IncomingMessage → standard fetch Request → Hono → Response.
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      // Collect body bytes for methods that have one.
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
        JSON.stringify({ error: { code: 'ADAPTER_ERROR', message: (err as Error).message } }),
      );
    }
  });

  const port: number = await new Promise((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Failed to bind carveout test server'));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    pool,
    port,
    baseUrl,
    tenantRepo,
    apiKeyRepo,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/**
 * Insert a tenant and a paired API key directly via the live repos. Returns
 * the plaintext API key (only chance to capture it — the DB only stores the
 * sha256 hash). Scopes default to `['admin']` so the forward test can reach
 * /api/v1/admin/tenants/:id; pass `scopes: []` to assert the 403/empty-scope
 * branch.
 */
export async function seedTenantAndKey(
  handle: ForwardTestHandle,
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
