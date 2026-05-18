import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEditorCommand } from '../../../src/commands/config.js';

describe('getEditorCommand', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses $EDITOR when set', () => {
    vi.stubEnv('EDITOR', 'code --wait');
    expect(getEditorCommand()).toBe('code --wait');
  });

  it('uses $VISUAL as fallback', () => {
    vi.stubEnv('EDITOR', '');
    vi.stubEnv('VISUAL', 'subl -w');
    expect(getEditorCommand()).toBe('subl -w');
  });

  it('defaults to vi', () => {
    vi.stubEnv('EDITOR', '');
    vi.stubEnv('VISUAL', '');
    expect(getEditorCommand()).toBe('vi');
  });
});
