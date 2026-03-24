import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findProjectRoot } from '../../../src/config/project-detection.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'node:fs';

const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  mockExistsSync.mockReset();
});

describe('findProjectRoot', () => {
  it('returns the directory containing spatula.yaml', () => {
    mockExistsSync.mockImplementation((p) => p === '/projects/myapp/spatula.yaml');
    const result = findProjectRoot('/projects/myapp');
    expect(result).toBe('/projects/myapp');
  });

  it('walks up directories to find spatula.yaml', () => {
    mockExistsSync.mockImplementation((p) => p === '/projects/myapp/spatula.yaml');
    const result = findProjectRoot('/projects/myapp/src/nested');
    expect(result).toBe('/projects/myapp');
  });

  it('returns null when spatula.yaml is not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);
    const result = findProjectRoot('/projects/myapp/src');
    expect(result).toBeNull();
  });

  it('stops at filesystem root and returns null', () => {
    mockExistsSync.mockReturnValue(false);
    const result = findProjectRoot('/');
    expect(result).toBeNull();
  });
});
