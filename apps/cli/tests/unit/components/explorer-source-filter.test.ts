import { describe, it, expect } from 'vitest';
import { cycleSourceFilter } from '../../../src/components/explorer/source-filter.js';

describe('cycleSourceFilter', () => {
  it('cycles all -> local -> remote -> all', () => {
    expect(cycleSourceFilter('all')).toBe('local');
    expect(cycleSourceFilter('local')).toBe('remote');
    expect(cycleSourceFilter('remote')).toBe('all');
  });
});
