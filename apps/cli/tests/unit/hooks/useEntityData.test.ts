import { describe, it, expect, vi } from 'vitest';

// Mock useStdout for terminal dimensions
vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useStdout: () => ({ stdout: { rows: 40, columns: 120 } }),
  };
});

describe('useEntityData', () => {
  it('module exports useEntityData function', async () => {
    const mod = await import('../../../src/hooks/useEntityData.js');
    expect(typeof mod.useEntityData).toBe('function');
  });
});
