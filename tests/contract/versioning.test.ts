/**
 * API-10: URL-versioning contract.
 *
 * Every path in the served OpenAPI spec MUST live under `/api/v1/` OR be the
 * single well-known sibling-root path `/.well-known/spatula-version` (RFC 8615).
 * This is the gate that catches an accidentally-mounted route at a versionless
 * path (e.g., `/jobs` instead of `/api/v1/jobs`) which would silently break
 * the freeze guarantee for v1.x consumers.
 *
 * Source of truth: docs/compat-policy.md — "URL versioning" section.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ContractServer } from './helpers/server-harness.js';

let server: ContractServer;
let spec: { paths: Record<string, unknown> };

describe('API-10 URL versioning', () => {
  beforeAll(async () => {
    server = await startServer();
    const res = await fetch(`${server.url}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    spec = (await res.json()) as { paths: Record<string, unknown> };
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it('every OpenAPI path is under /api/v1/ or /.well-known/', () => {
    const offenders: string[] = [];
    for (const path of Object.keys(spec.paths)) {
      const ok = path === '/.well-known/spatula-version' || path.startsWith('/api/v1/');
      if (!ok) offenders.push(path);
    }
    expect(offenders, `Paths violating URL versioning: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the spec includes at least one /api/v1/ path (sanity check)', () => {
    const v1Paths = Object.keys(spec.paths).filter((p) => p.startsWith('/api/v1/'));
    expect(v1Paths.length).toBeGreaterThan(0);
  });

  it('the spec includes the well-known sibling-root version path', () => {
    expect(Object.keys(spec.paths)).toContain('/.well-known/spatula-version');
  });
});
