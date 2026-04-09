import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMetrics, shutdownMetrics, registerGauges } from '../../src/metrics.js';

describe('metrics', () => {
  afterEach(async () => {
    await shutdownMetrics();
  });

  it('creates metrics instance with all instruments', () => {
    const metrics = createMetrics({ enabled: false });
    expect(metrics).toBeDefined();
    expect(metrics.httpRequestDuration).toBeDefined();
    expect(metrics.httpRequestsTotal).toBeDefined();
    expect(metrics.httpActiveConnections).toBeDefined();
    expect(metrics.queueJobDuration).toBeDefined();
    expect(metrics.queueJobsTotal).toBeDefined();
    expect(metrics.llmTokensUsed).toBeDefined();
    expect(metrics.llmRequestDuration).toBeDefined();
    expect(metrics.llmCostUsd).toBeDefined();
    expect(metrics.pagesProcessedTotal).toBeDefined();
    expect(metrics.pageCrawlDuration).toBeDefined();
    expect(metrics.entitiesCreatedTotal).toBeDefined();
    expect(metrics.exportSizeBytes).toBeDefined();
    expect(metrics.circuitBreakerState).toBeDefined();
    expect(metrics.circuitBreakerRejectionsTotal).toBeDefined();
  });

  it('returns no-op metrics when disabled', () => {
    const metrics = createMetrics({ enabled: false });
    expect(metrics).toBeDefined();
    expect(metrics.httpRequestsTotal).toBeDefined();
    // Verify no-op instruments don't throw when used
    expect(() => metrics.httpRequestsTotal.add(1)).not.toThrow();
  });
});

describe('registerGauges', () => {
  it('does not throw when metrics are initialized', () => {
    createMetrics({ enabled: false });
    const deps = {
      jobRepo: { countByStatus: vi.fn().mockResolvedValue(3) },
      tenantRepo: { countAll: vi.fn().mockResolvedValue(10) },
      queueProvider: { getQueueDepth: vi.fn().mockResolvedValue(5) },
    };
    expect(() => registerGauges(deps)).not.toThrow();
  });
});
