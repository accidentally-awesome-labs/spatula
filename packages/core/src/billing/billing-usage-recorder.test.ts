import { describe, it, expect, vi } from 'vitest';
import { BillingUsageRecorder } from './billing-usage-recorder.js';
import type { LLMUsageRecorder, LLMUsageRecord } from '../interfaces/llm-client.js';

function createMockQuotaEnforcer() {
  return {
    recordUsage: vi.fn().mockResolvedValue(undefined),
    check: vi.fn(),
    checkAndRecord: vi.fn(),
    isExportFormatAllowed: vi.fn(),
  };
}

function createMockInnerRecorder(): LLMUsageRecorder {
  return { record: vi.fn() };
}

const sampleUsage: LLMUsageRecord = {
  model: 'gpt-4',
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  costUsd: 0.01,
  durationMs: 500,
  purpose: 'extraction',
};

describe('BillingUsageRecorder', () => {
  it('delegates to inner recorder', () => {
    const inner = createMockInnerRecorder();
    const enforcer = createMockQuotaEnforcer();
    const recorder = new BillingUsageRecorder(inner, enforcer as any, 'tenant-1');
    recorder.record(sampleUsage);
    expect(inner.record).toHaveBeenCalledWith(sampleUsage);
  });

  it('records token usage via quotaEnforcer', async () => {
    const enforcer = createMockQuotaEnforcer();
    const recorder = new BillingUsageRecorder(undefined, enforcer as any, 'tenant-1');
    recorder.record(sampleUsage);
    // recordUsage is fire-and-forget, so await a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(enforcer.recordUsage).toHaveBeenCalledWith('tenant-1', 'llm_tokens', 150);
  });

  it('does not record when totalTokens is 0', async () => {
    const enforcer = createMockQuotaEnforcer();
    const recorder = new BillingUsageRecorder(undefined, enforcer as any, 'tenant-1');
    recorder.record({ ...sampleUsage, totalTokens: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(enforcer.recordUsage).not.toHaveBeenCalled();
  });

  it('handles inner recorder being undefined', () => {
    const enforcer = createMockQuotaEnforcer();
    const recorder = new BillingUsageRecorder(undefined, enforcer as any, 'tenant-1');
    expect(() => recorder.record(sampleUsage)).not.toThrow();
  });

  it('swallows recordUsage errors without throwing', async () => {
    const enforcer = createMockQuotaEnforcer();
    enforcer.recordUsage.mockRejectedValue(new Error('DB failure'));
    const recorder = new BillingUsageRecorder(undefined, enforcer as any, 'tenant-1');
    expect(() => recorder.record(sampleUsage)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    // Should not propagate — fire-and-forget
  });
});
