import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

import { Spinner } from '../../../../src/components/shared/index.js';

describe('Spinner', () => {
  it('renders without crashing', () => {
    const { lastFrame } = render(<Spinner />);
    expect(lastFrame()).toBeTruthy();
  });

  it('displays the default "Loading..." label', () => {
    const { lastFrame } = render(<Spinner />);
    expect(lastFrame()!).toContain('Loading...');
  });

  it('displays a custom label when provided', () => {
    const { lastFrame } = render(<Spinner label="Processing data..." />);
    expect(lastFrame()!).toContain('Processing data...');
    expect(lastFrame()!).not.toContain('Loading...');
  });
});
