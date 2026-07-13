/**
 * Browser e2e: full OIDC + SSE reconnect chain.
 *
 * A browser smoke client performs the full chain:
 *   OIDC login via Dex -> ws-token -> SSE subscribe -> disconnect ->
 *   reconnect with Last-Event-ID -> resume, without manual intervention.
 *
 * Prerequisites (must be met before this suite can run):
 *   1. Playwright Chromium binaries:
 *        npx playwright install chromium
 *      (or: pnpm --filter @spatula/cli exec playwright install chromium)
 *   2. Docker for Dex IDP:
 *        docker compose -f examples/auth-dex/docker-compose.yml up -d
 *   3. Postgres: TEST_DATABASE_URL env (default: postgresql://spatula:spatula@localhost:5432/spatula_test)
 *   4. Redis: REDIS_URL env (default: redis://localhost:6379)
 *
 * Run command:
 *   pnpm exec vitest run --config tests/e2e/browser/vitest.config.ts
 *
 * See tests/e2e/browser/README.md for full setup walkthrough.
 *
 * NOTE: This suite is NOT run in normal CI. Run it explicitly in an environment
 * with Docker, Chromium, Postgres, and Redis available.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import * as http from 'node:http';
import * as url from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEX_ISSUER = 'http://localhost:5556/dex';
const DEX_CLIENT_ID = 'spatula-browser';
// Use 127.0.0.1 (explicit IPv4) to avoid macOS resolving 'localhost' to ::1
// which would route to any IPv6 wildcard server already occupying port 3000.
// Port 4000 avoids the common port-3000 conflict with Next.js dev servers.
const DEX_REDIRECT_URI = 'http://127.0.0.1:4000/callback';
const DEX_SCOPES = 'openid email profile';
const DEV_EMAIL = 'dev@example.com';
const DEV_PASSWORD = 'password';

const API_PORT = 19876; // dedicated port to avoid conflicts with other suites
const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;

const ROOT = resolve(__dirname, '../../..');

// ─────────────────────────────────────────────────────────────────────────────
// PKCE helpers (same pattern as examples/auth-dex/smoke/browser-flow.ts)
// ─────────────────────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(64);
  let result = '';
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  if (!payload) throw new Error('Invalid JWT — no payload segment');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dex health probe
// ─────────────────────────────────────────────────────────────────────────────

async function waitForDex(timeoutMs = 30_000): Promise<void> {
  const discoveryUrl = `${DEX_ISSUER}/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(discoveryUrl);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dex not healthy after ${timeoutMs}ms: ${String(lastErr)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth callback capture — temporary HTTP server on localhost:3000
// ─────────────────────────────────────────────────────────────────────────────

function captureOAuthCallback(timeoutMs = 30_000): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url ?? '', true);
      if (parsed.pathname === '/callback' && parsed.query['code']) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Auth complete — you may close this tab.</h1></body></html>');
        server.close();
        resolve({
          code: String(parsed.query['code']),
          state: String(parsed.query['state'] ?? ''),
        });
      } else {
        res.writeHead(400);
        res.end('unexpected callback');
        server.close();
        reject(new Error(`Unexpected callback path: ${req.url}`));
      }
    });
    server.listen(4000, '127.0.0.1');
    server.on('error', (e) => reject(e));
    setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API server bootstrap (JWT strategy, Postgres + Redis)
// ─────────────────────────────────────────────────────────────────────────────

interface ApiHandle {
  baseUrl: string;
  close(): void;
}

async function startApiServer(): Promise<ApiHandle> {
  const {
    createDatabasePool,
    TenantRepository,
    ApiKeyRepository,
    JobRepository,
    UserTenantRepository,
    SchemaRepository,
    ExtractionRepository,
    EntityRepository,
    EntitySourceRepository,
    ActionRepository,
    ExportRepository,
    CrawlTaskRepository,
  } = await import('@spatula/db');
  const { createApp } = await import('../../../apps/api/src/app.js');
  const { JwtAuthProvider } = await import('../../../apps/api/src/auth/jwt-provider.js');
  const { JobManager } = await import('@spatula/queue');
  const { DEFAULT_API_KEY_SCOPES } = await import('@spatula/shared');
  const Redis = (await import('ioredis')).default;

  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://spatula:spatula@localhost:5432/spatula_test';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const { pool, db } = createDatabasePool(databaseUrl);
  const tenantRepo = new TenantRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);
  const jobRepo = new JobRepository(db);
  const userTenantRepo = new UserTenantRepository(db);
  const schemaRepo = new SchemaRepository(db);
  const extractionRepo = new ExtractionRepository(db);
  const entityRepo = new EntityRepository(db);
  const entitySourceRepo = new EntitySourceRepository(db);
  const actionRepo = new ActionRepository(db);
  const exportRepo = new ExportRepository(db);
  const taskRepo = new CrawlTaskRepository(db);
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });

  // Wire a real JobManager so POST /api/v1/jobs can persist to the DB.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const jobManager = new JobManager({
    jobRepo,
    taskRepo,
    schemaRepo,
    queues: {} as any, // not needed for createJob
    tenantRepo,
  });

  // Set JWT env vars before creating the app — createApp reads them at construction.
  process.env.AUTH_STRATEGY = 'jwt';
  process.env.JWT_ISSUER = DEX_ISSUER;
  process.env.JWT_AUDIENCE = DEX_CLIENT_ID;
  process.env.JWT_JWKS_URL = `${DEX_ISSUER}/keys`;

  // Grant browser OIDC users (human users via authorization-code + PKCE) the
  // standard API key scopes. Dex browser JWTs carry no application-level scopes
  // claim (Dex rejects custom scopes). The `defaultBrowserUserScopes` option
  // in JwtAuthProvider grants this explicit scope set to any scope-less JWT that
  // is NOT a registered M2M client — safe for this test server.
  // Production servers MUST NOT set this option.
  const authProvider = new JwtAuthProvider({
    issuer: DEX_ISSUER,
    audience: DEX_CLIENT_ID,
    jwksUrl: `${DEX_ISSUER}/keys`,
    defaultBrowserUserScopes: [...DEFAULT_API_KEY_SCOPES],
  });

  const deps = {
    dbPool: pool,
    jobRepo,
    schemaRepo,
    extractionRepo,
    entityRepo,
    entitySourceRepo,
    actionRepo,
    taskRepo,
    jobManager,
    exportRepo,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo,
    apiKeyRepo,
    userTenantRepo,
    authProvider,
    redis,
  } as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const app = createApp(deps);

  // Node http.IncomingMessage → fetch Request → Hono → fetch Response → Node ServerResponse
  // (carry-forward pattern from tests/contract/helpers/server-harness.ts)
  const server = http.createServer(async (req: any, res: any) => {
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : API_PORT;
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const hasBody = !(req.method === 'GET' || req.method === 'HEAD');
      let body: Uint8Array | undefined;
      if (hasBody) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (chunks.length > 0) body = Buffer.concat(chunks);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers as Record<string, string | string[]>)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(',') : v);
      }
      const request = new Request(reqUrl.toString(), {
        method: req.method,
        headers,
        body: (body as BodyInit | undefined) ?? null,
        duplex: hasBody ? 'half' : undefined,
      } as RequestInit);
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        // Pipe SSE stream — write chunks as they arrive (do not buffer).
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error('[test-server] error:', err);
      res.writeHead(500);
      res.end('internal error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(API_PORT, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    baseUrl: API_BASE_URL,
    close: () => {
      server.close();
      void pool.end();
      void redis.quit();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE subscription helper — runs in the Node test process (not the browser).
// Uses the subscribeJobEvents SDK method with the eventsource polyfill.
// ─────────────────────────────────────────────────────────────────────────────

interface CollectedEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

async function collectSseEvents(
  baseUrl: string,
  jobId: string,
  token: string,
  opts: {
    count: number;
    lastEventId?: string;
    timeoutMs?: number;
  },
): Promise<{ events: CollectedEvent[]; lastId: string | undefined; truncated: boolean }> {
  const { subscribeJobEvents } = await import('@spatula/client');
  // Minimal ClientLike — subscribeJobEvents only needs baseUrl.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const clientLike = { baseUrl } as any;

  const events: CollectedEvent[] = [];
  let lastId: string | undefined;
  let truncated = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      // Return whatever was collected — let the assertion decide if it's enough.
      resolve({ events, lastId, truncated });
    }, opts.timeoutMs ?? 10_000);

    const unsubscribe = subscribeJobEvents(clientLike, jobId, {
      token,
      lastEventId: opts.lastEventId,
      onEvent: (evt: import('@spatula/client').JobEvent) => {
        const collected = evt as CollectedEvent;
        events.push(collected);
        lastId = collected.id;
        if (events.length >= opts.count) {
          clearTimeout(timeout);
          unsubscribe();
          resolve({ events, lastId, truncated });
        }
      },
      onReplayTruncated: () => {
        truncated = true;
      },
      onError: (err: Event) => {
        clearTimeout(timeout);
        reject(new Error(`SSE error: ${String(err)}`));
      },
    });
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Browser OIDC + SSE reconnect chain', () => {
  let browser: Browser;
  let context: BrowserContext;
  let apiServer: ApiHandle;
  let accessToken: string;
  let jobId: string;
  // tenantId is extracted from the job creation response and used when publishing
  // test events so the SSE handler's tenant filter accepts them.
  let tenantId: string;

  // Track if Dex was started by us (so we know whether to tear it down).
  let dexStartedByUs = false;

  beforeAll(async () => {
    // ── Step 0: Ensure Dex is running ───────────────────────────────────────
    // Try to connect first — maybe it's already up (developer workflow).
    let dexHealthy = false;
    try {
      const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`);
      dexHealthy = res.ok;
    } catch {
      // Not up yet.
    }

    if (!dexHealthy) {
      // Boot Dex via docker compose.
      // execFileSync is used instead of exec to avoid shell injection.
      // All arguments are hardcoded strings — no user input.
      const dexDir = resolve(ROOT, 'examples/auth-dex');
      try {
        execFileSync('docker', ['compose', 'up', '-d'], {
          cwd: dexDir,
          stdio: 'pipe',
          timeout: 60_000,
        });
        dexStartedByUs = true;
      } catch (e) {
        throw new Error(
          `Failed to start Dex IDP: ${String(e)}\n\n` +
            'Fix: cd examples/auth-dex && docker compose up -d',
        );
      }
    }

    // Poll until Dex discovery doc is healthy.
    await waitForDex(30_000);

    // ── Step 1: Boot API server with JWT auth strategy ───────────────────────
    apiServer = await startApiServer();

    // ── Step 2: Launch Chromium (for the OIDC login step) ───────────────────
    // Requires: npx playwright install chromium (one-time setup).
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  }, 120_000);

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    apiServer?.close();

    if (dexStartedByUs) {
      const dexDir = resolve(ROOT, 'examples/auth-dex');
      try {
        // execFileSync — hardcoded safe args, no user input.
        execFileSync('docker', ['compose', 'down'], {
          cwd: dexDir,
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch {
        // Best-effort cleanup — do not fail the suite if teardown fails.
      }
    }
  }, 60_000);

  it('Step 1: OIDC authorization-code + PKCE login via Dex produces access token', async () => {
    // Fetch discovery doc to get live endpoints.
    const discoveryRes = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`);
    expect(discoveryRes.ok, 'Dex discovery doc should return 200').toBe(true);
    const discovery = (await discoveryRes.json()) as Record<string, string>;

    const authEndpoint = discovery['authorization_endpoint'];
    const tokenEndpoint = discovery['token_endpoint'];
    expect(authEndpoint, 'discovery doc must have authorization_endpoint').toBeTruthy();
    expect(tokenEndpoint, 'discovery doc must have token_endpoint').toBeTruthy();

    // Generate PKCE code verifier + S256 challenge.
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    const state = randomBytes(12).toString('hex');

    // Build the authorization URL.
    const authUrl = new URL(authEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', DEX_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', DEX_REDIRECT_URI);
    authUrl.searchParams.set('scope', DEX_SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Start callback capture server BEFORE navigating the browser.
    const callbackPromise = captureOAuthCallback(30_000);

    // Launch a Playwright page and drive the Dex login form.
    // The browser does PKCE natively — we hand it the code_challenge and it
    // handles the rest. We do NOT hand-roll the verifier on the browser side.
    const page = await context.newPage();
    try {
      await page.goto(authUrl.toString());

      // Dex password login form: fill email + password, submit.
      await page.waitForSelector('input[name="login"]', { timeout: 15_000 });
      await page.fill('input[name="login"]', DEV_EMAIL);
      await page.fill('input[name="password"]', DEV_PASSWORD);
      await page.click('button[type="submit"]');

      // Wait for the redirect to our callback server on 127.0.0.1:4000/callback.
      await page.waitForURL(/127\.0\.0\.1:4000\/callback/, { timeout: 15_000 });
    } finally {
      await page.close();
    }

    // Capture the authorization code from the callback server.
    const { code } = await callbackPromise;
    expect(code, 'OAuth authorization code must be non-empty').toBeTruthy();

    // Exchange authorization code for tokens.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_REDIRECT_URI,
      client_id: DEX_CLIENT_ID,
      code_verifier: codeVerifier,
    });
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    expect(tokenRes.ok, `Token endpoint returned ${tokenRes.status}`).toBe(true);
    const tokenData = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokenData['access_token'], 'Token response must include access_token').toBeTruthy();

    accessToken = tokenData['access_token'] as string;

    // Verify it is a real JWT with the expected issuer + audience.
    const claims = decodeJwtPayload(accessToken);
    expect(claims['iss']).toBe(DEX_ISSUER);
    expect(
      Array.isArray(claims['aud'])
        ? (claims['aud'] as string[]).includes(DEX_CLIENT_ID)
        : claims['aud'] === DEX_CLIENT_ID,
      'access token aud must include spatula-browser',
    ).toBe(true);
  });

  it('Step 2: create a job using the OIDC access token', async () => {
    expect(accessToken, 'accessToken must be set from Step 1').toBeTruthy();

    const res = await fetch(`${API_BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'e2e-oidc-sse-reconnect-test',
        description: 'Created by oidc-sse-flow.spec.ts e2e suite',
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
      }),
    });

    expect([200, 201], `POST /api/v1/jobs should return 200 or 201, got ${res.status}`).toContain(
      res.status,
    );
    const body = (await res.json()) as {
      data?: { id?: string; tenantId?: string };
      id?: string;
      tenantId?: string;
    };
    jobId = (body.data?.id ?? body.id) as string;
    tenantId = (body.data?.tenantId ?? body.tenantId) as string;
    expect(jobId, 'job response must include an id').toBeTruthy();
    expect(tenantId, 'job response must include a tenantId').toBeTruthy();
  });

  it('Step 3: POST /api/v1/ws-token returns a single-use stream token', async () => {
    expect(accessToken, 'accessToken must be set').toBeTruthy();

    const res = await fetch(`${API_BASE_URL}/api/v1/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status, `POST /api/v1/ws-token should return 200, got ${res.status}`).toBe(200);
    const body = (await res.json()) as { data?: { token?: string }; token?: string };
    const token = body.data?.token ?? body.token;
    expect(token, 'ws-token response must include a token').toBeTruthy();
  });

  it('Steps 4-6: SSE subscribe → events arrive → disconnect → reconnect with Last-Event-ID → resume strictly after captured id', async () => {
    expect(accessToken, 'accessToken must be set').toBeTruthy();
    expect(jobId, 'jobId must be set from Step 2').toBeTruthy();

    // ── Get a fresh stream token ─────────────────────────────────────────
    const tokenRes = await fetch(`${API_BASE_URL}/api/v1/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(tokenRes.ok, 'ws-token call must succeed').toBe(true);
    const tokenBody = (await tokenRes.json()) as { data?: { token?: string }; token?: string };
    const streamToken = tokenBody.data?.token ?? tokenBody.token;
    expect(streamToken, 'stream token must be present').toBeTruthy();

    // ── Publish events into the Redis stream before connecting ───────────
    // The SSE handler replays buffered events from Redis Streams on connect.
    const { RedisEventPublisher } = await import('@spatula/queue');
    const Redis = (await import('ioredis')).default;
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const publisherRedis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });
    const publisher = new RedisEventPublisher(publisherRedis);

    // Publish 3 events before the first connection opens.
    // Must use valid JobEventType values and include tenantId so the SSE
    // handler's tenant filter accepts them (event.tenantId !== tenantId check).
    await publisher.publish(jobId, {
      type: 'job_status_changed',
      jobId,
      tenantId,
      data: { status: 'running', src: 'batch-1' },
    });
    await publisher.publish(jobId, {
      type: 'crawl_progress',
      jobId,
      tenantId,
      data: { pagesProcessed: 1, src: 'batch-1' },
    });
    await publisher.publish(jobId, {
      type: 'crawl_progress',
      jobId,
      tenantId,
      data: { pagesProcessed: 2, src: 'batch-1' },
    });

    // ── Step 4: SSE subscribe — collect up to 3 events ───────────────────
    const firstBatch = await collectSseEvents(API_BASE_URL, jobId, streamToken!, {
      count: 3,
      timeoutMs: 15_000,
    });

    expect(
      firstBatch.events.length,
      `Expected ≥1 events in first batch (got ${firstBatch.events.length}). ` +
        'Requires live Redis + API server with SSE handler and RedisEventPublisher.',
    ).toBeGreaterThan(0);

    // Verify monotonic SSE id ordering (Redis stream ids: `{ms}-{seq}`).
    const ids = firstBatch.events.map((e) => e.id).filter(Boolean);
    for (let i = 1; i < ids.length; i++) {
      expect(
        ids[i]! > ids[i - 1]!,
        `Event ids must be monotonically increasing: ${ids[i - 1]} → ${ids[i]}`,
      ).toBe(true);
    }

    // ── Step 5: Disconnect (collectSseEvents already closed the connection)
    const capturedLastId = firstBatch.lastId;
    expect(capturedLastId, 'capturedLastId must be set').toBeTruthy();

    // Publish 2 more events during the "disconnect window".
    await publisher.publish(jobId, {
      type: 'crawl_progress',
      jobId,
      tenantId,
      data: { pagesProcessed: 10, src: 'gap' },
    });
    await publisher.publish(jobId, {
      type: 'crawl_progress',
      jobId,
      tenantId,
      data: { pagesProcessed: 11, src: 'gap' },
    });

    // Brief pause to let events settle in Redis.
    await new Promise((r) => setTimeout(r, 250));

    // ── Step 6: Get a NEW stream token and reconnect with Last-Event-ID ──
    const reconnectTokenRes = await fetch(`${API_BASE_URL}/api/v1/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(reconnectTokenRes.ok, 'reconnect ws-token call must succeed').toBe(true);
    const reconnectBody = (await reconnectTokenRes.json()) as {
      data?: { token?: string };
      token?: string;
    };
    const reconnectToken = reconnectBody.data?.token ?? reconnectBody.token;
    expect(reconnectToken, 'reconnect stream token must be present').toBeTruthy();

    const resumeBatch = await collectSseEvents(API_BASE_URL, jobId, reconnectToken!, {
      count: 2,
      lastEventId: capturedLastId,
      timeoutMs: 15_000,
    });

    // Resume events must be strictly AFTER the captured id (no duplicates, no gaps).
    expect(
      resumeBatch.events.length,
      `Expected ≥1 resumed events after reconnect with lastEventId=${capturedLastId}`,
    ).toBeGreaterThan(0);

    for (const evt of resumeBatch.events) {
      expect(
        evt.id > capturedLastId!,
        `Resumed event id "${evt.id}" must be strictly AFTER captured id "${capturedLastId}"`,
      ).toBe(true);
    }

    // The gap events (published during disconnect window) must appear in the resume batch.
    const hasGapData = resumeBatch.events.some((e) => e.data['src'] === 'gap');
    expect(
      hasGapData,
      'Reconnected stream must replay events published during the disconnect window',
    ).toBe(true);

    // Cleanup publisher redis connection.
    await publisherRedis.quit().catch(() => {});
  });
});
