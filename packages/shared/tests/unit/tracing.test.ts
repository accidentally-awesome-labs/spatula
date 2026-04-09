import { describe, it, expect } from 'vitest';
import { initTracing, shutdownTracing } from '../../src/tracing.js';

describe('tracing', () => {
  it('returns without error when no endpoint is configured', () => {
    // Smoke test: OTEL SDK internals can't be spied on in unit tests.
    // Verifies initialization completes without error.
    delete process.env.OTEL_EXPORTER_ENDPOINT;
    expect(() => initTracing()).not.toThrow();
  });

  it('shutdownTracing is safe to call without prior init', async () => {
    // Smoke test: OTEL SDK internals can't be spied on in unit tests.
    // Verifies initialization completes without error.
    await expect(shutdownTracing()).resolves.not.toThrow();
  });

  it('initTracing with endpoint config does not throw', () => {
    // Smoke test: OTEL SDK internals can't be spied on in unit tests.
    // Verifies initialization completes without error.
    expect(() => initTracing({ endpoint: 'http://localhost:4318' })).not.toThrow();
  });

  it('after init with endpoint, shutdownTracing completes without error', async () => {
    // Smoke test: OTEL SDK internals can't be spied on in unit tests.
    // Verifies initialization completes without error.
    initTracing({ endpoint: 'http://localhost:4318', serviceName: 'test-service' });
    await expect(shutdownTracing()).resolves.not.toThrow();
  });
});
