import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupAuthContext,
  bearerHeaders,
  createApiKeyDirectly,
  minimalJobBody,
  type AuthTestContext,
} from './helpers.js';

describe('Tier 5B: API Key Authentication & Scope Enforcement', () => {
  let ctx: AuthTestContext;
  let dbAvailable = false;

  beforeAll(async () => {
    const result = await setupAuthContext();
    if (!result) return;
    ctx = result;
    dbAvailable = true;
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── Test 1: Create API key → returns key string and id ──────────────
  it('creates API key via API and returns raw key + id', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'new-key', scopes: ['jobs:read', 'jobs:write'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.key).toMatch(/^sk_live_/);
    expect(body.data.name).toBe('new-key');
    expect(body.data.scopes).toEqual(['jobs:read', 'jobs:write']);
  });

  // ── Test 2: Authenticate with valid API key → 200 ──────────────────
  it('authenticates with valid API key', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(res.status).toBe(200);
  });

  // ── Test 3: Revoked key → 401 ──────────────────────────────────────
  it('rejects revoked API key with 401', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a key via API
    const createRes = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'to-revoke' }),
    });
    const { data: created } = await createRes.json();

    // Revoke it
    const revokeRes = await ctx.app.request(`/api/v1/api-keys/${created.id}`, {
      method: 'DELETE',
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(revokeRes.status).toBe(200);

    // Try to use revoked key
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(created.key),
    });
    expect(res.status).toBe(401);
  });

  // ── Test 4: Malformed token → 401 ──────────────────────────────────
  it('rejects malformed token with 401', async (t) => {
    if (!dbAvailable) return t.skip();
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: { Authorization: 'Bearer garbage123', 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_ERROR');
  });

  // ── Test 5: Key with jobs:read → GET jobs succeeds ─────────────────
  it('allows GET with jobs:read scope', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(ctx.db, ctx.tenantId, ['jobs:read'], 'read-only');
    const res = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(rawKey),
    });
    expect(res.status).toBe(200);
  });

  // ── Test 6: Key with jobs:read → POST jobs rejected → 403 ─────────
  it('rejects POST with jobs:read-only scope', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(ctx.db, ctx.tenantId, ['jobs:read'], 'read-only-2');
    const res = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // ── Test 7: Admin scope → all endpoints succeed ────────────────────
  it('allows admin scope on all endpoints', async (t) => {
    if (!dbAvailable) return t.skip();
    const getRes = await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    expect(getRes.status).toBe(200);

    const keyRes = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify({ name: 'admin-created' }),
    });
    expect(keyRes.status).toBe(201);

    const jobRes = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(ctx.adminKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(jobRes.status).toBe(201);
  });

  // ── Test 8: Empty scopes → all write endpoints rejected → 403 ─────
  it('rejects all writes with empty scopes', async (t) => {
    if (!dbAvailable) return t.skip();
    const { rawKey } = await createApiKeyDirectly(ctx.db, ctx.tenantId, [], 'no-scopes');

    const jobPost = await ctx.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify(minimalJobBody()),
    });
    expect(jobPost.status).toBe(403);

    const keyPost = await ctx.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: bearerHeaders(rawKey),
      body: JSON.stringify({ name: 'blocked' }),
    });
    expect(keyPost.status).toBe(403);
  });
});
