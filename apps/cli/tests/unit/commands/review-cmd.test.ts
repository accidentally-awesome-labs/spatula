import { describe, it, expect } from 'vitest';
import { buildReviewStore, formatReviewSummary } from '../../../src/commands/review.js';

// ---------------------------------------------------------------------------
// buildReviewStore
// ---------------------------------------------------------------------------

describe('buildReviewStore', () => {
  it('creates a store with activeJobId set to projectId', () => {
    const store = buildReviewStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
    expect(state.mode).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// formatReviewSummary
// ---------------------------------------------------------------------------

describe('formatReviewSummary', () => {
  it('formats counts correctly', () => {
    const output = formatReviewSummary(4, 2);
    expect(output).toContain('Reviewed 4');
    expect(output).toContain('2 remaining');
  });

  it('handles zero counts', () => {
    const output = formatReviewSummary(0, 0);
    expect(output).toContain('Reviewed 0');
    expect(output).toContain('0 remaining');
  });
});
