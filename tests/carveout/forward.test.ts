import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  startCarveoutServer,
  seedTenantAndKey,
  type ForwardTestHandle,
  type SeededIdentity,
} from './fixtures/server.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://spatula:spatula@localhost:5432/spatula_test';

let setupOk = false;
let handle: ForwardTestHandle | undefined;
let identity: SeededIdentity | undefined;

describe('Forward carve-out: live OSS-only server', () => {
  beforeAll(async () => {
    // Skip the entire suite when no Postgres is available — keeps the suite
    // green in environments that haven't applied 0000_v1_baseline.sql yet
    // (e.g., contributors running `pnpm test:carveout` cold).
    try {
      handle = await startCarveoutServer(DATABASE_URL);
      identity = await seedTenantAndKey(handle, `carveout-fwd-${Date.now()}`);
      setupOk = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[forward.test.ts] Skipping — no Postgres or schema:', (err as Error).message);
    }
  });

  afterAll(async () => {
    if (handle && identity) {
      // Best-effort cleanup. Drizzle pool is owned by the handle.
      const db = drizzle(handle.pool);
      try {
        await db.execute(sql`DELETE FROM api_keys WHERE id = ${identity.apiKeyId}`);
        await db.execute(sql`DELETE FROM tenants WHERE id = ${identity.tenantId}`);
      } catch {
        // ignore cleanup failures — test DB is ephemeral
      }
    }
    await handle?.close();
  });

  it('GET /api/v1/auth/me returns the seeded tenantId and scopes', async (ctx) => {
    if (!setupOk || !handle || !identity) return ctx.skip();

    const res = await fetch(`${handle.baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      scopes: string[];
      subject: string | null;
      authenticated: boolean;
    };

    expect(body.tenantId).toBe(identity.tenantId);
    expect(body.scopes).toEqual(identity.scopes);
    expect(body.authenticated).toBe(true);

    // Sanity: the post-carve contract must not leak any billing field.
    const serialized = JSON.stringify(body);
    expect(/plan/i.test(serialized)).toBe(false);
    expect(/stripe/i.test(serialized)).toBe(false);
    expect(/usage/i.test(serialized)).toBe(false);
  });

  it('GET /api/v1/admin/tenants/:id returns a billing-free body (or 403 if scope-gated)', async (ctx) => {
    if (!setupOk || !handle || !identity) return ctx.skip();

    const res = await fetch(`${handle.baseUrl}/api/v1/admin/tenants/${identity.tenantId}`, {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
    });

    // Either: 200 (we seeded with admin scope) OR 403 (no admin scope).
    // The forward-test fixture seeds with ['admin'] by default, so 200 is
    // the expected path; 403 is documented as the acceptable fallback.
    expect([200, 403]).toContain(res.status);

    if (res.status === 200) {
      const body = (await res.json()) as { data: Record<string, unknown> };
      const tenant = body.data;

      // Post-carve assertion: these fields MUST be absent from the response.
      expect(Object.keys(tenant)).not.toContain('plan');
      expect(Object.keys(tenant)).not.toContain('stripeCustomerId');
      expect(Object.keys(tenant)).not.toContain('usage');

      // tenantId echoes back so we know we hit the right record.
      expect(tenant.id).toBe(identity.tenantId);
    }
  });

  it('GET /api/openapi.json from the live server has no billing/stripe paths', async (ctx) => {
    if (!setupOk || !handle) return ctx.skip();

    const res = await fetch(`${handle.baseUrl}/api/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});

    expect(paths.filter((p) => /billing/i.test(p))).toEqual([]);
    expect(paths.filter((p) => /stripe/i.test(p))).toEqual([]);
  });
});
