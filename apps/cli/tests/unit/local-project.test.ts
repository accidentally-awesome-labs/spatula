import { describe, it, expect } from 'vitest';
import { slugifyPath } from '../../src/local-project.js';

describe('slugifyPath', () => {
  it('takes last two path segments', () => {
    expect(slugifyPath('/home/user/projects/my-crawl')).toBe('projects-my-crawl');
  });

  it('lowercases and strips non-alphanumeric', () => {
    expect(slugifyPath('/Users/Me/My Project!')).toBe('me-my-project-');
  });

  it('normalises Windows backslashes', () => {
    expect(slugifyPath('C:\\Users\\me\\data\\crawl-test')).toBe('data-crawl-test');
  });

  it('handles single segment', () => {
    expect(slugifyPath('/crawl')).toBe('crawl');
  });
});

import { openLocalProject } from '../../src/local-project.js';

describe('openLocalProject', () => {
  it('throws when no spatula.yaml found', async () => {
    await expect(openLocalProject('/tmp/nonexistent-project-dir')).rejects.toThrow(
      'No spatula.yaml found',
    );
  });
});
