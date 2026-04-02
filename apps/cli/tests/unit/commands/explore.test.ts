import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildExploreStore, runExploreCommand } from '../../../src/commands/explore.js';
import { openLocalProject } from '../../../src/local-project.js';

vi.mock('../../../src/local-project.js', () => ({
  openLocalProject: vi.fn(),
}));

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

// ---------------------------------------------------------------------------
// runExploreCommand
// ---------------------------------------------------------------------------

describe('runExploreCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('prints message and exits when no entities', async () => {
    const mockClose = vi.fn();
    (openLocalProject as any).mockResolvedValue({
      dataSource: {
        getStatus: vi.fn().mockResolvedValue({ totalEntities: 0 }),
      },
      projectRoot: '/tmp/test',
      projectId: 'test-project',
      close: mockClose,
    });

    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runExploreCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No entities'));
    expect(mockClose).toHaveBeenCalled();
  });

  it('calls close even when getStatus throws', async () => {
    const mockClose = vi.fn();
    (openLocalProject as any).mockResolvedValue({
      dataSource: {
        getStatus: vi.fn().mockRejectedValue(new Error('db error')),
      },
      projectRoot: '/tmp/test',
      projectId: 'test-project',
      close: mockClose,
    });

    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runExploreCommand()).rejects.toThrow('db error');
    expect(mockClose).toHaveBeenCalled();
  });
});
