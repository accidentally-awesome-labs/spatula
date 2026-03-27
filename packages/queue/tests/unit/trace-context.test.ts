import { describe, it, expect } from 'vitest';
import { injectTraceContext, extractTraceContext } from '../../src/trace-context.js';

describe('trace context', () => {
  it('injectTraceContext returns data unchanged when no active trace', () => {
    const data = { jobId: 'j1', tenantId: 't1' };
    const result = injectTraceContext(data);
    expect(result.jobId).toBe('j1');
    expect(result.tenantId).toBe('t1');
  });

  it('extractTraceContext returns ctx and no-op cleanup when _traceContext is absent', () => {
    const data = { jobId: 'j1' };
    const { ctx, cleanup } = extractTraceContext(data, 'test-span');
    expect(ctx).toBeDefined();
    expect(cleanup).toBeTypeOf('function');
    expect(() => cleanup()).not.toThrow();
  });
});
