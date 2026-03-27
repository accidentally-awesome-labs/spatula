import { describe, it, expect } from 'vitest';
import { initTracing, shutdownTracing } from '../../src/tracing.js';

describe('tracing', () => {
  it('returns without error when no endpoint is configured', () => {
    delete process.env.OTEL_EXPORTER_ENDPOINT;
    expect(() => initTracing()).not.toThrow();
  });

  it('shutdownTracing is safe to call without prior init', async () => {
    await expect(shutdownTracing()).resolves.not.toThrow();
  });

  it('initTracing with endpoint config does not throw', () => {
    expect(() => initTracing({ endpoint: 'http://localhost:4318' })).not.toThrow();
  });

  it('after init with endpoint, shutdownTracing completes without error', async () => {
    initTracing({ endpoint: 'http://localhost:4318', serviceName: 'test-service' });
    await expect(shutdownTracing()).resolves.not.toThrow();
  });
});
