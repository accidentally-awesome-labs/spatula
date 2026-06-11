/**
 * API-04: RFC 8594 Deprecation / Sunset / Link headers on offset-only routes.
 *
 * Cursor-paginated endpoints are the canonical shape at v1. Offset-paginated
 * fallbacks emit three RFC 8594 headers on every response:
 *   - Deprecation: <HTTP-date>
 *   - Sunset:      <HTTP-date>
 *   - Link:        rel="successor-version" → /docs/compat-policy or a route-
 *                  specific successor
 *
 * Routes that take a cursor (or don't have a deprecated offset shape) MUST NOT
 * emit these headers — that's the gate this suite catches accidental leakage
 * onto cursor-mode responses.
 *
 * Tested routes:
 *   - GET /api/v1/jobs (offset-only listing — always emits)
 *   - GET /api/v1/jobs/:jobId/entities?cursor=... (cursor mode — must NOT emit)
 *
 * The cursor-mode test uses a synthetic cursor that may return 404; we assert
 * on the absence of the three headers regardless of the body status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, seedTenantAndKey, type ContractServer } from './helpers/server-harness.js';

let server: ContractServer;
let apiKey: string;

describe('API-04 deprecation headers on offset-only routes', () => {
  beforeAll(async () => {
    server = await startServer();
    const identity = await seedTenantAndKey(server, 'deprecation-test-tenant');
    apiKey = identity.apiKey;
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it('GET /api/v1/jobs (offset-only) emits Deprecation + Sunset + Link', async () => {
    const res = await fetch(`${server.url}/api/v1/jobs?limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // The route uses the real jobRepo wired in the harness, so we expect 200.
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation'), 'Deprecation header').toBeTruthy();
    expect(res.headers.get('Sunset'), 'Sunset header').toBeTruthy();
    const link = res.headers.get('Link');
    expect(link, 'Link header').toBeTruthy();
    expect(link).toMatch(/rel="successor-version"/);
  });

  it('Sunset is a parseable HTTP-date in the future', async () => {
    const res = await fetch(`${server.url}/api/v1/jobs?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const sunset = res.headers.get('Sunset');
    expect(sunset).toBeTruthy();
    const sunsetDate = new Date(sunset!);
    expect(Number.isNaN(sunsetDate.getTime())).toBe(false);
    expect(sunsetDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('cursor-mode entities response does NOT emit deprecation headers', async () => {
    // Synthetic jobId — the entities route uses cursor mode when `cursor` is
    // present; even if the underlying jobId isn't found, the route handler
    // takes the cursor branch BEFORE applyDeprecationHeaders runs, so the
    // headers MUST NOT appear regardless of the response status.
    const bogus = '00000000-0000-0000-0000-000000000000';
    const fakeCursor = Buffer.from(JSON.stringify({ id: bogus })).toString('base64url');
    const res = await fetch(
      `${server.url}/api/v1/jobs/${bogus}/entities?cursor=${fakeCursor}&limit=10`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    // We don't care about the body status — could be 200 with empty list, 404, or 500
    // because the harness stubs entityRepo. The contract is: NO deprecation
    // headers on cursor-mode requests.
    expect(res.headers.get('Deprecation'), 'no Deprecation on cursor mode').toBeNull();
    expect(res.headers.get('Sunset'), 'no Sunset on cursor mode').toBeNull();
    expect(res.headers.get('Link'), 'no Link on cursor mode').toBeNull();
  });
});
