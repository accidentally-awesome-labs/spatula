/**
 * API-13: experimental-namespace contract.
 *
 * The @spatula/client SDK reserves `client.experimental.*` for experimental
 * surfaces. v1.0 ships exactly ONE: `forensic`. Every
 * OTHER property access MUST throw a fail-loud Error referencing the
 * experimental-surface policy, so call sites that depend on an unimplemented
 * surface fail at the use site, not silently with undefined.
 *
 * The Proxy MUST tolerate well-known JS-runtime property accesses (`then`,
 * `toJSON`, `constructor`, symbols) — these are touched by Promise/await
 * mechanisms and `JSON.stringify`, and throwing on them would make the
 * namespace un-debuggable.
 *
 * Mirrors the scenario in
 * `packages/client/tests/unit/experimental-namespace.test.ts` but exercises it
 * through the full SpatulaClient constructor path that v1 callers will hit.
 * This is the public contract gate; the unit test is the implementation gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SpatulaClient } from '@spatula/client';
import { startServer, type ContractServer } from './helpers/server-harness.js';

let server: ContractServer;

describe('API-13 client.experimental namespace', () => {
  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it('exposes the forensic surface and fails loud on any other property access', () => {
    const client = new SpatulaClient({ baseUrl: server.url });
    const experimental = (client as unknown as { experimental: Record<string, unknown> })
      .experimental;

    // v1.0 ships exactly ONE experimental surface: forensic.
    // It MUST resolve to a real surface, not throw.
    expect(() => experimental.forensic).not.toThrow();
    expect(experimental.forensic).toBeDefined();

    // Every OTHER surface is unimplemented and must fail loud at the use site.
    expect(() => experimental.anyOtherThing).toThrow(/experimental surface/i);
    expect(() => experimental['snake_case_thing']).toThrow(/is not available/i);
  });

  it('does NOT throw on JS-runtime well-known property accesses (debug introspection)', () => {
    const client = new SpatulaClient({ baseUrl: server.url });
    const experimental = (client as unknown as { experimental: Record<string, unknown> })
      .experimental;

    // Promise/await mechanism touches `.then`
    expect(() => experimental.then).not.toThrow();
    // JSON.stringify touches `.toJSON`
    expect(() => experimental.toJSON).not.toThrow();
    // Object inspection
    expect(() => experimental.constructor).not.toThrow();
    // Symbol accesses (Symbol.iterator, etc.)
    expect(() => experimental[Symbol.iterator as unknown as string]).not.toThrow();
  });

  it('JSON.stringify on the namespace does not throw', () => {
    const client = new SpatulaClient({ baseUrl: server.url });
    const experimental = (client as unknown as { experimental: Record<string, unknown> })
      .experimental;
    expect(() => JSON.stringify(experimental)).not.toThrow();
  });
});
