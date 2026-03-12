import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Panel } from '../../../../src/components/shared/index.js';

describe('Panel', () => {
  it('renders children content', () => {
    const { lastFrame } = render(<Panel>Hello World</Panel>);
    expect(lastFrame()).toContain('Hello World');
  });

  it('renders title when provided', () => {
    const { lastFrame } = render(<Panel title="My Title">Content</Panel>);
    expect(lastFrame()).toContain('My Title');
    expect(lastFrame()).toContain('Content');
  });

  it('renders without title', () => {
    const { lastFrame } = render(<Panel>No title here</Panel>);
    expect(lastFrame()).toContain('No title here');
  });

  it('accepts a custom borderColor', () => {
    const { lastFrame } = render(
      <Panel title="Colored" borderColor="green">
        Green border
      </Panel>,
    );
    expect(lastFrame()).toContain('Colored');
    expect(lastFrame()).toContain('Green border');
  });
});
