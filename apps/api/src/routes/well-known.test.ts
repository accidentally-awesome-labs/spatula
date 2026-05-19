/**
 * Phase 16 plan 16-3 Task 2 — tests for `GET /.well-known/spatula-version`.
 *
 * The response shape is FROZEN at v1:
 *   { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors[] } }
 *
 * v1.0 values: supportMatrix.minClientMajor === 1; deprecatedClientMajors === [].
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { wellKnownRoute } from './well-known.js';
import type { AppEnv } from '../types.js';

function makeApp() {
  const app = new OpenAPIHono<AppEnv>();
  app.route('/', wellKnownRoute());
  return app;
}

describe('Phase 16 plan 16-3 Task 2: GET /.well-known/spatula-version', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env so tests don't leak.
    process.env = { ...originalEnv };
  });

  it('returns 200 + the four top-level keys present', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/spatula-version');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // EXACTLY four top-level keys.
    expect(Object.keys(body).sort()).toEqual(
      ['buildAt', 'gitSha', 'supportMatrix', 'version'].sort(),
    );
  });

  it('supportMatrix.minClientMajor === 1 (v1.0 baseline)', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/spatula-version');
    const body = (await res.json()) as {
      supportMatrix: { minClientMajor: number; deprecatedClientMajors: number[] };
    };
    expect(body.supportMatrix.minClientMajor).toBe(1);
  });

  it('supportMatrix.deprecatedClientMajors is an empty array (v1.0 baseline)', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/spatula-version');
    const body = (await res.json()) as {
      supportMatrix: { deprecatedClientMajors: number[] };
    };
    expect(Array.isArray(body.supportMatrix.deprecatedClientMajors)).toBe(true);
    expect(body.supportMatrix.deprecatedClientMajors).toHaveLength(0);
  });

  it('honors SPATULA_VERSION + GIT_SHA env vars when set', async () => {
    process.env.SPATULA_VERSION = '1.2.3';
    process.env.GIT_SHA = 'deadbeef';
    process.env.BUILD_AT = '2026-05-19T14:32:00.000Z';

    const app = makeApp();
    const res = await app.request('/.well-known/spatula-version');
    const body = (await res.json()) as { version: string; gitSha: string; buildAt: string };

    expect(body.version).toBe('1.2.3');
    expect(body.gitSha).toBe('deadbeef');
    expect(body.buildAt).toBe('2026-05-19T14:32:00.000Z');
  });

  it('falls back to "0.0.0-dev" / "unknown" / current ISO date when env not set', async () => {
    delete process.env.SPATULA_VERSION;
    delete process.env.GIT_SHA;
    delete process.env.BUILD_AT;

    const app = makeApp();
    const res = await app.request('/.well-known/spatula-version');
    const body = (await res.json()) as { version: string; gitSha: string; buildAt: string };

    expect(body.version).toBe('0.0.0-dev');
    expect(body.gitSha).toBe('unknown');
    // ISO 8601 UTC: YYYY-MM-DDTHH:mm:ss(.sss)?Z
    expect(body.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });
});
