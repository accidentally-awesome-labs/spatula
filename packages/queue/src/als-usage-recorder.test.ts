// packages/queue/src/als-usage-recorder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlsUsageRecorder } from './als-usage-recorder.js';
import { usageContext } from './usage-context.js';
import type { LLMUsageRecord } from '@spatula/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<LLMUsageRecord> = {}): LLMUsageRecord {
  return {
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.001234,
    durationMs: 500,
    purpose: 'extraction',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlsUsageRecorder', () => {
  let mockInsert: ReturnType<typeof vi.fn>;
  let recorder: AlsUsageRecorder;

  beforeEach(() => {
    mockInsert = vi.fn().mockResolvedValue(undefined);
    // Mock LlmUsageRepository — only `insert` is required
    const mockRepo = { insert: mockInsert } as any;
    recorder = new AlsUsageRecorder(mockRepo);
  });

  it('inserts with the tenantId + jobId from the active usageContext', async () => {
    const record = makeRecord();

    await usageContext.run({ tenantId: 'T1', jobId: 'J1' }, async () => {
      recorder.record(record);
      // Wait one microtask tick so the fire-and-forget .catch() resolves
      await Promise.resolve();
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'T1',
        jobId: 'J1',
        model: 'test-model',
      }),
    );
  });

  it('isolates concurrent usageContext scopes — no cross-attribution', async () => {
    const record1 = makeRecord({ model: 'model-a' });
    const record2 = makeRecord({ model: 'model-b' });

    // Interleave two concurrent ALS scopes. Each awaits a microtask before
    // calling record() to verify ALS isolation survives interleaving.
    await Promise.all([
      usageContext.run({ tenantId: 'T1', jobId: 'J1' }, async () => {
        await Promise.resolve(); // yield to let T2/J2 scope start
        recorder.record(record1);
        await Promise.resolve();
      }),
      usageContext.run({ tenantId: 'T2', jobId: 'J2' }, async () => {
        await Promise.resolve();
        recorder.record(record2);
        await Promise.resolve();
      }),
    ]);

    expect(mockInsert).toHaveBeenCalledTimes(2);

    const calls = mockInsert.mock.calls.map(
      (c) => c[0] as { tenantId: string; jobId: string; model: string },
    );
    const t1Call = calls.find((c) => c.model === 'model-a');
    const t2Call = calls.find((c) => c.model === 'model-b');

    expect(t1Call).toBeDefined();
    expect(t1Call!.tenantId).toBe('T1');
    expect(t1Call!.jobId).toBe('J1');

    expect(t2Call).toBeDefined();
    expect(t2Call!.tenantId).toBe('T2');
    expect(t2Call!.jobId).toBe('J2');
  });

  it('skips insert (no throw) when called outside any usageContext.run', async () => {
    // No usageContext.run wrapping this call — should log warn and return cleanly
    expect(() => recorder.record(makeRecord())).not.toThrow();
    // Give fire-and-forget a tick to settle
    await Promise.resolve();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('passes costUsd to repo.insert as a 6-decimal-place string', async () => {
    const record = makeRecord({ costUsd: 0.1234567 });

    await usageContext.run({ tenantId: 'T1', jobId: 'J1' }, async () => {
      recorder.record(record);
      await Promise.resolve();
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const insertArg = mockInsert.mock.calls[0][0] as { costUsd: string };
    expect(insertArg.costUsd).toBe('0.123457');
  });
});
