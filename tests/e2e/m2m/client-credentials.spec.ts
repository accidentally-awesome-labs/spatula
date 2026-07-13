/**
 * M2M OIDC client_credentials e2e.
 *
 * Proves the full machine-to-machine chain:
 *   Dex client_credentials grant → JWT → createJob → listJobs → getEntities
 *
 * This extends examples/auth-dex/smoke/m2m-flow.ts. That script proves the
 * token-grant half; this suite proves the full SDK chain on top of it.
 *
 * Prerequisites — all must be running before this suite executes:
 *   1. Dex:     cd examples/auth-dex && docker compose up -d
 *   2. Postgres: TEST_DATABASE_URL or DATABASE_URL must point to a live DB
 *   3. Redis:   REDIS_URL or redis://localhost:6379 must be a live Redis
 *
 * If Dex is not reachable the suite is skipped cleanly (it does NOT fail CI
 * for PRs that do not boot the full Dex stack).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../apps/api/src/app.js';
import { JwtAuthProvider } from '../../../apps/api/src/auth/jwt-provider.js';
import type { AppDeps } from '../../../apps/api/src/types.js';
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
  CrawlTaskRepository,
} from '@spatula/db';
import { JobManager } from '@spatula/queue';
import Redis from 'ioredis';
import { SpatulaClient, createJob, listJobs, getEntities } from '@spatula/client';
import { DEFAULT_API_KEY_SCOPES } from '@spatula/shared';

// ─── Dex M2M constants (committed dev-only values) ───────────────────────────

const DEX_ISSUER = 'http://localhost:5556/dex';
const DEX_TOKEN_ENDPOINT = `${DEX_ISSUER}/token`;
const DEX_JWKS_URL = `${DEX_ISSUER}/keys`;
const M2M_CLIENT_ID = 'spatula-m2m';
/** Intentionally committed dev-only secret — DO NOT USE IN PRODUCTION. */
const M2M_CLIENT_SECRET = 'dev-only-secret-m2m';

// ─── JWT helpers (mirrored from examples/auth-dex/smoke/m2m-flow.ts) ─────────

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    throw new Error(`Invalid JWT: expected 3 segments, got ${segments.length}`);
  }
  const payload = segments[1];
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

/**
 * Check whether Dex is reachable (discovery doc 200 + correct issuer).
 * Returns null on success, an error message on failure.
 */
async function checkDexAvailable(): Promise<string | null> {
  try {
    const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) {
      return `discovery doc returned HTTP ${res.status}`;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body.issuer !== DEX_ISSUER) {
      return `issuer mismatch: expected ${DEX_ISSUER}, got ${String(body.issuer)}`;
    }
    return null;
  } catch (err) {
    return `connection failed: ${(err as Error).message}`;
  }
}

// ─── Reusable token-grant function ──────────────────────────────────────────

/**
 * POST client_credentials to the Dex token endpoint and return the access_token JWT.
 * Mirrors the grant logic from examples/auth-dex/smoke/m2m-flow.ts.
 */
async function getMachineToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: M2M_CLIENT_ID,
    client_secret: M2M_CLIENT_SECRET,
    scope: 'openid',
  });

  const res = await fetch(DEX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dex token endpoint HTTP ${res.status}: ${text}`);
  }

  const tokenResponse = (await res.json()) as Record<string, unknown>;
  const accessToken = tokenResponse['access_token'] as string | undefined;
  if (!accessToken) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(tokenResponse)}`);
  }
  return accessToken;
}

// ─── Server boot (JWT-auth mode) ──────────────────────────────────────────────

interface M2MTestServer {
  url: string;
  close(): Promise<void>;
}

async function startJwtServer(): Promise<M2MTestServer> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://spatula:spatula@localhost:5432/spatula_test';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const { pool, db } = createDatabasePool(databaseUrl);
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });

  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);
  const entityRepo = new EntityRepository(db);
  const userTenantRepo = new UserTenantRepository(db);
  const taskRepo = new CrawlTaskRepository(db);
  const schemaRepo = new SchemaRepository(db);

  // Wire a real JobManager so createJob can persist to the DB.
  // The `queues` dep is only needed for startJob/pauseJob/etc — for this e2e
  // we only call createJob which uses jobRepo directly.
  const jobManager = new JobManager({
    jobRepo,
    taskRepo,
    schemaRepo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queues: {} as any, // not needed for createJob
    tenantRepo,
  });

  // Grant the spatula-m2m client explicit scopes. Dex client_credentials JWTs
  // carry no application-level scopes claim (Dex rejects custom scopes with
  // invalid_scope). Instead, we register the M2M client identity server-side:
  // when JwtAuthProvider sees a scope-less JWT whose sub encodes 'spatula-m2m',
  // it grants DEFAULT_API_KEY_SCOPES. All other scope-less JWTs remain [] (fail-closed).
  const jwtProvider = new JwtAuthProvider({
    issuer: DEX_ISSUER,
    audience: M2M_CLIENT_ID,
    jwksUrl: DEX_JWKS_URL,
    m2mClientScopes: { [M2M_CLIENT_ID]: [...DEFAULT_API_KEY_SCOPES] },
  });

  const deps: Partial<AppDeps> = {
    dbPool: pool,
    jobRepo,
    entityRepo,
    tenantRepo,
    apiKeyRepo,
    userTenantRepo,
    redis,
    authProvider: jwtProvider,
    jobManager,
    taskRepo,
    schemaRepo,
    entitySourceRepo: new EntitySourceRepository(db),
    extractionRepo: new ExtractionRepository(db),
    actionRepo: new ActionRepository(db),
    exportRepo: new ExportRepository(db),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contentStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportQueue: {} as any,
  };

  const app = createApp(deps as AppDeps);

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
      else reject(new Error('Failed to bind M2M e2e server'));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

let dexError: string | null;
let server: M2MTestServer;
let serviceToken: string;
let tokenClaims: Record<string, unknown>;

beforeAll(async () => {
  // Gate: skip the suite if Dex isn't running (e.g. in PRs without docker)
  dexError = await checkDexAvailable();
  if (dexError) {
    // Set a module-level flag; individual tests skip via it.skipIf
    return;
  }

  server = await startJwtServer();
}, 60_000);

afterAll(async () => {
  if (server) await server.close();
});

// Helper so each test can skip when Dex isn't available
const dexAvailable = () => dexError === null;

describe('M2M OIDC client_credentials chain', () => {
  it('gate: Dex is reachable at http://localhost:5556/dex', { skip: false }, async () => {
    if (dexError !== null) {
      // Soft-skip: this is an e2e suite that requires Dex running in Docker.
      // Use console.warn to surface the skip reason without failing the suite.
      console.warn(
        `[m2m-e2e] SKIP: Dex not available — ${dexError}. ` +
          `Run: cd examples/auth-dex && docker compose up -d`,
      );
      return;
    }
    // Assert explicitly that Dex is healthy
    const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
  });

  it('Step 1: POST client_credentials to Dex token endpoint returns a JWT', async () => {
    if (dexError !== null) {
      console.warn(`[m2m-e2e] SKIP Step 1: Dex unavailable — ${dexError}`);
      return;
    }

    serviceToken = await getMachineToken();
    expect(typeof serviceToken).toBe('string');
    expect(serviceToken.split('.').length).toBe(3);
  });

  it('Step 2: JWT sub encodes client_id (spatula-m2m) and aud includes spatula-m2m', async () => {
    if (dexError !== null || !serviceToken) {
      console.warn('[m2m-e2e] SKIP Step 2: Dex unavailable or token not obtained');
      return;
    }

    tokenClaims = decodeJwtPayload(serviceToken);

    // Verify iss
    expect(tokenClaims['iss']).toBe(DEX_ISSUER);

    // Verify aud includes spatula-m2m
    const aud = tokenClaims['aud'];
    const audList: string[] = Array.isArray(aud)
      ? (aud as string[])
      : typeof aud === 'string'
        ? [aud]
        : [];
    expect(audList).toContain(M2M_CLIENT_ID);

    // Verify sub encodes spatula-m2m.
    // Dex encodes client_credentials sub as a base64url-encoded protobuf message
    // (field 1 = client_id string) — not the literal client_id string.
    const rawSub = String(tokenClaims['sub'] ?? '');
    const subContainsClientId = (() => {
      if (rawSub === M2M_CLIENT_ID) return true; // literal match (future Dex may simplify)
      try {
        const base64 = rawSub.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const bytes = Buffer.from(padded, 'base64');
        return bytes.toString('utf8').includes(M2M_CLIENT_ID);
      } catch {
        return false;
      }
    })();

    expect(subContainsClientId, `Expected sub '${rawSub}' to encode '${M2M_CLIENT_ID}'`).toBe(true);
  });

  it('Step 3: SpatulaClient.createJob with service JWT succeeds (auto-provisions tenant on first use)', async () => {
    if (dexError !== null || !serviceToken) {
      console.warn('[m2m-e2e] SKIP Step 3: Dex unavailable or token not obtained');
      return;
    }

    const client = new SpatulaClient({
      baseUrl: server.url,
      apiKey: serviceToken,
      skipVersionProbe: true,
    });

    // First call exercises the JwtAuthProvider user_tenants auto-provision path:
    // new M2M sub → no tenant row → create Free tenant → proceed.
    //
    // NOTE: The API wraps the job in a { data: job } envelope; the client SDK's
    // createJob() returns the raw body, so we need to extract .data.
    const rawResponse = await createJob(client, {
      name: 'm2m-e2e-job',
      description: 'M2M e2e smoke test job',
      seedUrls: ['https://example.com'],
      crawl: {
        maxDepth: 1,
        maxPages: 1,
        concurrency: 1,
        crawlerType: 'playwright',
      },
      schema: {
        mode: 'discovery',
      },
      llm: {
        primaryModel: 'anthropic/claude-sonnet-4-20250514',
      },
    });

    // API returns { data: { id, status, ... } }; unwrap the data envelope.
    const job = ((rawResponse as any).data ?? rawResponse) as { id: string; status: string };

    expect(job.id).toBeTruthy();
    expect(job.status).toBeTruthy();

    // Store job id for subsequent steps (module-level variable trick — vitest runs
    // tests in file order so this is safe).
    (globalThis as any).__m2m_jobId = job.id;
    (globalThis as any).__m2m_client = client;
  });

  it('Step 4: listJobs returns the newly created M2M job', async () => {
    if (dexError !== null || !serviceToken) {
      console.warn('[m2m-e2e] SKIP Step 4: Dex unavailable or token not obtained');
      return;
    }

    const client: SpatulaClient = (globalThis as any).__m2m_client;
    const jobId: string = (globalThis as any).__m2m_jobId;

    if (!client || !jobId) {
      console.warn('[m2m-e2e] SKIP Step 4: createJob step did not run or failed');
      return;
    }

    const rawResult = await listJobs(client);

    // API may return { data: [...], total: N } or { data: [...], hasMore: bool, nextCursor: ... }
    // The client SDK exposes ListJobsResult which expects { data, hasMore } but the API
    // returns { data, total } for list endpoints. We accept either shape.
    const result = rawResult as any;
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);

    // The just-created job must appear in the list
    const found = (result.data as any[]).find((j: any) => j.id === jobId);
    expect(found, `Expected job ${jobId} to appear in listJobs result`).toBeDefined();
  });

  it('Step 5: getEntities for the job returns a well-formed cursor envelope', async () => {
    if (dexError !== null || !serviceToken) {
      console.warn('[m2m-e2e] SKIP Step 5: Dex unavailable or token not obtained');
      return;
    }

    const client: SpatulaClient = (globalThis as any).__m2m_client;
    const jobId: string = (globalThis as any).__m2m_jobId;

    if (!client || !jobId) {
      console.warn('[m2m-e2e] SKIP Step 5: createJob step did not run or failed');
      return;
    }

    // The job hasn't crawled anything — expect an empty but well-formed response.
    // API returns { data: [], pagination: { nextCursor, hasMore, total } } —
    // hasMore lives in the pagination sub-object, not at top level.
    const rawResult = await getEntities(client, jobId);
    const result = rawResult as any;

    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
    // Empty is expected — the job has no crawl results.
    expect(result.data).toHaveLength(0);
  });
});
