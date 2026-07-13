/**
 * Tests for client.experimental namespace behavior.
 *
 * v1.0 ships one experimental surface: forensic.
 * - client.experimental.forensic → real ForensicSurface (does NOT throw)
 * - client.experimental.<anything-else> → throws fail-loud
 * - Well-known JS props (then, toJSON, constructor, symbols) → undefined (no throw)
 */
import { describe, it, expect, vi } from 'vitest';
import { SpatulaClient } from '../../src/client.js';

describe('client.experimental namespace (v1.0 = ONE surface: forensic)', () => {
  it('throws with an explanatory message on non-forensic property access', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    // Accessing any non-forensic property on `experimental` must throw.
    expect(() => {
      (client.experimental as unknown as Record<string, unknown>).foo;
    }).toThrow(/not available/);
  });

  it('error message names the one live experimental surface', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    try {
      // Use a non-forensic property to trigger the fail-loud path
      (client.experimental as unknown as Record<string, unknown>).forensicExtractions;
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('forensic');
    }
  });

  it('does NOT throw on forensic property access (the one live experimental surface)', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(() => {
      (client.experimental as unknown as Record<string, unknown>).forensic;
    }).not.toThrow();
  });

  it('does NOT throw on well-known JS-runtime symbols (debug introspection)', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    // The Proxy intentionally returns undefined for `then`/`toJSON`/etc. so
    // the namespace can be inspected without exploding.
    expect(() => {
      const namespace = client.experimental as unknown as { then?: unknown };
      void namespace.then;
    }).not.toThrow();
  });
});
