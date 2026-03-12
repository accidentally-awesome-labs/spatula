import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Header } from '../../../../src/components/shared/index.js';

describe('Header', () => {
  it('renders "Spatula" app name', () => {
    const { lastFrame } = render(<Header mode="conversational" />);
    expect(lastFrame()).toContain('Spatula');
  });

  it('renders mode name for conversational mode', () => {
    const { lastFrame } = render(<Header mode="conversational" />);
    expect(lastFrame()).toContain('conversational');
  });

  it('renders mode name for dashboard mode', () => {
    const { lastFrame } = render(<Header mode="dashboard" />);
    expect(lastFrame()).toContain('dashboard');
  });

  it('renders mode name for review mode', () => {
    const { lastFrame } = render(<Header mode="review" />);
    expect(lastFrame()).toContain('review');
  });

  it('renders mode name for explorer mode', () => {
    const { lastFrame } = render(<Header mode="explorer" />);
    expect(lastFrame()).toContain('explorer');
  });
});
