/**
 * Isolation suite server harness — Phase 17 plan 17-07.
 *
 * Extends the contract harness pattern with REAL repos for the isolation
 * matrix. The contract harness stubs most repos as `{} as any` to avoid
 * wiring unused deps — that's fine for schema validation, but the isolation
 * suite needs routes to return 403/404 (not 500) for cross-tenant lookups.
 *
 * This harness wires all repos that are reached by the routes in the OpenAPI
 * spec so they can perform tenant-aware lookups and return proper isolation
 * responses instead of `deps.X is not a function` 500s.
 *
 * Pattern carries forward from tests/contract/helpers/server-harness.ts:
 *   - Node-builtin http.Server adapter (no @hono/node-server dep)
 *   - ONE server per suite (beforeAll/afterAll)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../apps/api/src/app.js';
import { ApiKeyAuthProvider } from '../../apps/api/src/auth/api-key-provider.js';
import type { AppDeps } from '../../apps/api/src/types.js';
import {
  createDatabasePool,
  TenantRepository,
  ApiKeyRepository,
  JobRepository,
  EntityRepository,
  EntitySourceRepository,
  SchemaRepository,
  ExtractionRepository,
  ActionRepository,
  ExportRepository,
  UserTenantRepository,
} from '@spatula/db';
import type { Pool } from 'pg';
import Redis from 'ioredis';

export interface IsolationServer {
  url: string;
  pool: Pool;
  close(): Promise<void>;
}

export interface IsolationServerOptions {
  databaseUrl?: string;
  redisUrl?: string;
}

/**
 * Boot an apps/api server with REAL repos for the isolation suite.
 *
 * Unlike the contract harness which stubs most repos, this wires all repos
 * so routes can perform real DB lookups and return proper 403/404 isolation
 * responses rather than 500 "function not found" errors.
 */
export async function startIsolationServer(
  options: IsolationServerOptions = {},
): Promise<IsolationServer> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://spatula:spatula@localhost:5432/spatula_test';

  const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

  const { pool, db } = createDatabasePool(databaseUrl);

  // Wire all real repos (unlike contract harness which stubs non-core repos)
  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);
  const entityRepo = new EntityRepository(db);
  const entitySourceRepo = new EntitySourceRepository(db);
  const schemaRepo = new SchemaRepository(db);
  const extractionRepo = new ExtractionRepository(db);
  const actionRepo = new ActionRepository(db);
  const exportRepo = new ExportRepository(db);
  const userTenantRepo = new UserTenantRepository(db);

  // Redis is required for ws-token (SSE cross-tenant test) and rate limiting
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });

  const deps: Partial<AppDeps> = {
    dbPool: pool,
    jobRepo,
    entityRepo,
    entitySourceRepo,
    schemaRepo,
    extractionRepo,
    actionRepo,
    exportRepo,
    tenantRepo,
    apiKeyRepo,
    userTenantRepo,
    redis,
    authProvider: new ApiKeyAuthProvider(apiKeyRepo),
    // Stub out complex service deps that are not needed for isolation checks
    // (routes using these will 500, which we document and skip in the matrix)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskRepo: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jobManager: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contentStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportQueue: {} as any,
  };

  const app = createApp(deps as AppDeps);

  // Node http.Server adapter (same as contract harness)
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
      else reject(new Error('Failed to bind isolation test server'));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  return {
    url: `http://127.0.0.1:${port}`,
    pool,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      try {
        await redis.quit();
      } catch {
        // ignore
      }
    },
  };
}
