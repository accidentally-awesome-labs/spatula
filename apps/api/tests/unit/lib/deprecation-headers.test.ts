import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { applyDeprecationHeaders } from '../../../src/lib/deprecation-headers.js';

function createTestApp(opts?: { successorLink?: string }) {
  const app = new Hono();
  app.get('/deprecated', (c) => {
    applyDeprecationHeaders(c, opts);
    return c.json({ ok: true });
  });
  return app;
}

describe('applyDeprecationHeaders (RFC 8594)', () => {
  it('writes Deprecation, Sunset, and Link headers on the response', async () => {
    const app = createTestApp();
    const res = await app.request('/deprecated');
    expect(res.status).toBe(200);

    const deprecation = res.headers.get('Deprecation');
    const sunset = res.headers.get('Sunset');
    const link = res.headers.get('Link');

    expect(deprecation).not.toBeNull();
    expect(sunset).not.toBeNull();
    expect(link).not.toBeNull();
  });

  it('Sunset header is a valid HTTP-date that parses', async () => {
    const app = createTestApp();
    const res = await app.request('/deprecated');
    const sunset = res.headers.get('Sunset');
    expect(sunset).not.toBeNull();
    // HTTP-date parses to a real Date
    const parsed = new Date(sunset!);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    // Sunset target is 2027-05-01 (~12 months post-v1.0 launch)
    expect(parsed.getUTCFullYear()).toBe(2027);
    expect(parsed.getUTCMonth()).toBe(4); // May (0-indexed)
    expect(parsed.getUTCDate()).toBe(1);
  });

  it('Deprecation header is a valid HTTP-date that parses', async () => {
    const app = createTestApp();
    const res = await app.request('/deprecated');
    const deprecation = res.headers.get('Deprecation');
    expect(deprecation).not.toBeNull();
    const parsed = new Date(deprecation!);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
  });

  it('Link header defaults to pointing at /docs/compat-policy with rel=successor-version', async () => {
    const app = createTestApp();
    const res = await app.request('/deprecated');
    const link = res.headers.get('Link');
    expect(link).toContain('rel="successor-version"');
    expect(link).toContain('/docs/compat-policy');
  });

  it('successorLink option overrides the default Link header', async () => {
    const custom = '</api/v1/entities?cursor=...>; rel="successor-version"';
    const app = createTestApp({ successorLink: custom });
    const res = await app.request('/deprecated');
    const link = res.headers.get('Link');
    expect(link).toBe(custom);
  });
});
