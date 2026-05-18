import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ActivityFeed } from '../../../../src/components/dashboard/ActivityFeed.js';

describe('ActivityFeed', () => {
  it('renders recent actions with type labels', () => {
    const actions = [
      {
        type: 'add_field',
        status: 'applied',
        createdAt: '2026-03-13T10:00:00Z',
        payload: { fieldName: 'price' },
      },
      {
        type: 'merge_entities',
        status: 'pending_review',
        createdAt: '2026-03-13T10:01:00Z',
        payload: { canonicalName: 'Acme Corp' },
      },
    ];
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;
    expect(frame).toContain('add_field: price');
    expect(frame).toContain('merge_entities: Acme Corp');
  });

  it('shows status indicators for each action', () => {
    const actions = [
      {
        type: 'add_field',
        status: 'applied',
        createdAt: '2026-03-13T10:00:00Z',
        payload: {},
      },
      {
        type: 'remove_field',
        status: 'pending_review',
        createdAt: '2026-03-13T10:01:00Z',
        payload: {},
      },
      {
        type: 'rename_field',
        status: 'rejected',
        createdAt: '2026-03-13T10:02:00Z',
        payload: {},
      },
    ];
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;
    expect(frame).toContain('✓');
    expect(frame).toContain('○');
    expect(frame).toContain('✗');
  });

  it('shows empty message when no actions', () => {
    const { lastFrame } = render(<ActivityFeed actions={[]} />);
    const frame = lastFrame()!;
    expect(frame).toContain('No activity yet');
  });

  it('limits display to most recent 8 actions', () => {
    // Use letter suffixes to avoid substring collisions (e.g. 'action_1' matching 'action_10')
    const labels = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
    ];
    const actions = labels.map((label, i) => ({
      type: `action_${label}`,
      status: 'applied',
      createdAt: `2026-03-13T10:${String(i).padStart(2, '0')}:00Z`,
      payload: {},
    }));
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;
    // Should show the 8 most recent (indices 4-11, reverse chronological)
    for (const label of ['echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']) {
      expect(frame).toContain(`action_${label}`);
    }
    // Should NOT show the 4 oldest (indices 0-3)
    for (const label of ['alpha', 'bravo', 'charlie', 'delta']) {
      expect(frame).not.toContain(`action_${label}`);
    }
  });
});
