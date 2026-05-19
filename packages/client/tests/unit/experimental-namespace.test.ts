import { describe, it, expect, vi } from 'vitest';
import { SpatulaClient } from '../../src/client.js';

describe('client.experimental namespace (v1.0 = empty)', () => {
  it('throws with an explanatory message on any property access', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    // Accessing any property on `experimental` must throw the v1.0 message.
    expect(() => {
      // Cast to any-record to allow arbitrary property access for the test.
      (client.experimental as unknown as Record<string, unknown>).foo;
    }).toThrow(/zero experimental surfaces/);
  });

  it('mentions the Phase 18 forensic-extractions admin endpoint', () => {
    const client = new SpatulaClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    try {
      (client.experimental as unknown as Record<string, unknown>).forensicExtractions;
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('Phase 18');
    }
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
