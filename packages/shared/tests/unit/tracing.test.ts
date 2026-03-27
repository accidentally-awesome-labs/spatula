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
});
