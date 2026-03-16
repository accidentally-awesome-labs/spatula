import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

describe('FilterBar', () => {
  it('module exports FilterBar component', async () => {
    const mod = await import('../../../../src/components/explorer/FilterBar.js');
    expect(mod.FilterBar).toBeDefined();
  });

  it('shows entity count when no filter active', async () => {
    const { FilterBar } = await import('../../../../src/components/explorer/FilterBar.js');
    const { lastFrame } = render(
      <FilterBar
        filterQuery=""
        filterMode="local"
        matchCount={0}
        totalCount={42}
        focused={false}
        onQueryChange={vi.fn()}
        onToggleMode={vi.fn()}
        onSubmit={vi.fn()}
        onBlur={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('42 entities');
  });

  it('shows match count when filter is active', async () => {
    const { FilterBar } = await import('../../../../src/components/explorer/FilterBar.js');
    const { lastFrame } = render(
      <FilterBar
        filterQuery="bluetooth"
        filterMode="local"
        matchCount={5}
        totalCount={42}
        focused={true}
        onQueryChange={vi.fn()}
        onToggleMode={vi.fn()}
        onSubmit={vi.fn()}
        onBlur={vi.fn()}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('5 of 42 matches');
    expect(frame).toContain('bluetooth');
  });

  it('shows mode indicator', async () => {
    const { FilterBar } = await import('../../../../src/components/explorer/FilterBar.js');
    const { lastFrame } = render(
      <FilterBar
        filterQuery=""
        filterMode="ai"
        matchCount={0}
        totalCount={10}
        focused={false}
        onQueryChange={vi.fn()}
        onToggleMode={vi.fn()}
        onSubmit={vi.fn()}
        onBlur={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('[AI]');
  });
});
