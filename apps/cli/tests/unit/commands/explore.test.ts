import { describe, it, expect } from 'vitest';
import { buildExploreStore } from '../../../src/commands/explore.js';

describe('buildExploreStore', () => {
  it('creates a store with activeJobId set to projectId', () => {
    const store = buildExploreStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
    expect(state.mode).toBe('explorer');
  });

  it('uses projectId as tenantId for the underlying config', () => {
    const store = buildExploreStore('my-project-id');
    const state = store.getState();
    expect(state.config.tenantId).toBe('my-project-id');
  });

  it('starts with empty entities array', () => {
    const store = buildExploreStore('test-project');
    const state = store.getState();
    expect(state.entities).toEqual([]);
    expect(state.totalEntityCount).toBe(0);
  });
});
