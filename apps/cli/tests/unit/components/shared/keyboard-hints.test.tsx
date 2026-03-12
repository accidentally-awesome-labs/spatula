import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { KeyboardHints } from '../../../../src/components/shared/index.js';

describe('KeyboardHints', () => {
  it('renders all hint keys', () => {
    const hints = [
      { key: 'q', description: 'Quit' },
      { key: 'tab', description: 'Switch mode' },
    ];
    const { lastFrame } = render(<KeyboardHints hints={hints} />);
    expect(lastFrame()).toContain('q');
    expect(lastFrame()).toContain('tab');
  });

  it('renders all hint descriptions', () => {
    const hints = [
      { key: 'q', description: 'Quit' },
      { key: 'tab', description: 'Switch mode' },
    ];
    const { lastFrame } = render(<KeyboardHints hints={hints} />);
    expect(lastFrame()).toContain('Quit');
    expect(lastFrame()).toContain('Switch mode');
  });

  it('renders with a single hint', () => {
    const hints = [{ key: 'enter', description: 'Submit' }];
    const { lastFrame } = render(<KeyboardHints hints={hints} />);
    expect(lastFrame()).toContain('enter');
    expect(lastFrame()).toContain('Submit');
  });

  it('renders empty when no hints provided', () => {
    const { lastFrame } = render(<KeyboardHints hints={[]} />);
    // Should render without crashing; frame should exist
    expect(lastFrame()).toBeDefined();
  });
});
