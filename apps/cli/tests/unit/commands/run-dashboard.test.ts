import { describe, it, expect } from 'vitest';
import { buildRunDashboardStore } from '../../../src/components/dashboard/RunDashboard.js';

describe('buildRunDashboardStore', () => {
  it('creates a store with activeJobId set', () => {
    const store = buildRunDashboardStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
  });
});
