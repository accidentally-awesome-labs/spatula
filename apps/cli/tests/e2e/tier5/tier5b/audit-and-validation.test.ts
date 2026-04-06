import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '../../tier4/helpers.js';
import {
  setupAuthContext,
  bearerHeaders,
  type AuthTestContext,
} from './helpers.js';

/** Small delay to let async audit writes complete (setImmediate-based). */
const waitForAudit = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('Tier 5B: Audit Logging, Tenant Validation & OpenAPI', () => {
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

  // ── Test 30: Successful auth → auth.login_success audit entry ─────
  it('logs auth.login_success on successful authentication', async (t) => {
    if (!dbAvailable) return t.skip();

    // Make an authenticated request
    await ctx.app.request('/api/v1/jobs', {
      headers: bearerHeaders(ctx.adminKey),
    });
    await waitForAudit();

    // Query audit log for success events
    const entries = await ctx.repos.auditLogRepo.findByTenant(ctx.tenantId);
    const successEvents = entries.filter(
      (e: { action: string }) => e.action === 'auth.login_success',
    );
    expect(successEvents.length).toBeGreaterThan(0);
  });

  // ── Test 31: Failed auth → auth.login_failure audit entry ─────────
  it('logs auth.login_failure on failed authentication', async (t) => {
    if (!dbAvailable) return t.skip();

    // Record timestamp before the request to filter out stale entries
    const before = new Date();

    // Make a request with an invalid token
    await ctx.app.request('/api/v1/jobs', {
      headers: { Authorization: 'Bearer invalid-key-for-audit', 'Content-Type': 'application/json' },
    });
    await waitForAudit();

    // Failure events may not have a tenantId (auth failed before resolving tenant).
    // Query the audit_log table directly for failure events with a timestamp filter
    // to avoid matching stale entries from prior test runs.
    const { auditLog } = await import('@spatula/db/dist/schema/index.js');
    const { eq, gte, and } = await import('drizzle-orm');
    const failures = await ctx.db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, 'auth.login_failure'),
        gte(auditLog.createdAt, before),
      ))
      .limit(10);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].action).toBe('auth.login_failure');
  });

  // ── Test 32: Empty or invalid UUID in x-tenant-id → 400/401 ──────
  // Uses AUTH_STRATEGY=none to test the NoAuth provider's UUID validation.
  it('rejects empty or invalid x-tenant-id in no-auth mode', async (t) => {
    if (!dbAvailable) return t.skip();
    // Create a separate app with AUTH_STRATEGY=none
    const noAuthApp = await createTestApp({ authStrategy: 'none' });
    if (!noAuthApp) return t.skip();

    try {
      // Empty tenant ID
      const res1 = await noAuthApp.app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': '', 'Content-Type': 'application/json' },
      });
      expect(res1.status).toBe(401);

      // Invalid UUID
      const res2 = await noAuthApp.app.request('/api/v1/jobs', {
        headers: { 'x-tenant-id': 'not-a-uuid', 'Content-Type': 'application/json' },
      });
      expect(res2.status).toBe(401);
    } finally {
      await noAuthApp.cleanup();
    }
  });

  // ── Test 33: /api/openapi.json returns valid spec ─────────────────
  it('serves valid OpenAPI spec with registered routes', async (t) => {
    if (!dbAvailable) return t.skip();
    // No auth needed — openapi.json is in SKIP_AUTH_PATHS
    const res = await ctx.app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toMatch(/^3\./); // OpenAPI 3.x
    expect(body.paths).toBeDefined();
    // Spot-check: /api/v1/jobs path exists
    const jobsPath = body.paths['/api/v1/jobs'];
    expect(jobsPath).toBeDefined();
    expect(jobsPath.get).toBeDefined();
    expect(jobsPath.post).toBeDefined();
  });
});
