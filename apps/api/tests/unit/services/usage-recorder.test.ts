import { describe, it, expect, vi } from 'vitest';
import { DefaultUsageRecorder } from '../../../src/services/usage-recorder.js';
import type { LLMUsageRecord } from '@accidentally-awesome-labs/spatula-core';

function createUsageRecord(overrides?: Partial<LLMUsageRecord>): LLMUsageRecord {
  return {
    model: 'anthropic/claude-3-haiku',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.00015,
    durationMs: 350,
    purpose: 'extraction',
    ...overrides,
  };
}

describe('DefaultUsageRecorder', () => {
  it('record() calls metrics.llmTokensUsed.add() with correct attributes', () => {
    const metrics = {
      llmTokensUsed: { add: vi.fn() },
      llmCostUsd: { add: vi.fn() },
      llmRequestDuration: { record: vi.fn() },
    } as any;

    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1', undefined, metrics);
    const usage = createUsageRecord();
    recorder.record(usage);

    expect(metrics.llmTokensUsed.add).toHaveBeenCalledWith(150, {
      tenantId: 'tenant-1',
      jobId: 'job-1',
      model: 'anthropic/claude-3-haiku',
    });
  });

  it('record() calls metrics.llmCostUsd.add() with correct attributes', () => {
    const metrics = {
      llmTokensUsed: { add: vi.fn() },
      llmCostUsd: { add: vi.fn() },
      llmRequestDuration: { record: vi.fn() },
    } as any;

    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1', undefined, metrics);
    const usage = createUsageRecord();
    recorder.record(usage);

    expect(metrics.llmCostUsd.add).toHaveBeenCalledWith(0.00015, {
      tenantId: 'tenant-1',
      jobId: 'job-1',
      model: 'anthropic/claude-3-haiku',
    });
  });

  it('record() calls repo.insert() with correct fields (fire-and-forget)', () => {
    const repo = {
      insert: vi.fn().mockResolvedValue({ id: 'usage-1' }),
    } as any;

    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1', repo);
    const usage = createUsageRecord();
    recorder.record(usage);

    expect(repo.insert).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      jobId: 'job-1',
      model: 'anthropic/claude-3-haiku',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUsd: '0.000150',
      purpose: 'extraction',
    });
  });

  it('record() without metrics (undefined) does not throw', () => {
    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1');
    const usage = createUsageRecord();
    expect(() => recorder.record(usage)).not.toThrow();
  });

  it('record() without repo (undefined) does not throw', () => {
    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1', undefined, undefined);
    const usage = createUsageRecord();
    expect(() => recorder.record(usage)).not.toThrow();
  });

  it('record() handles repo.insert() failure silently (no throw)', async () => {
    const repo = {
      insert: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    } as any;

    const recorder = new DefaultUsageRecorder('tenant-1', 'job-1', repo);
    const usage = createUsageRecord();

    // record() is synchronous and fire-and-forget — should not throw
    expect(() => recorder.record(usage)).not.toThrow();

    // Let the promise rejection be caught by the .catch() handler
    await vi.waitFor(() => {
      expect(repo.insert).toHaveBeenCalled();
    });
  });
});
