import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../../src/components/App.js';
import { createCliStore } from '../../../src/store/index.js';

describe('App', () => {
  const noop = vi.fn();

  it('renders header with current mode', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(
      <App store={store} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Spatula');
    expect(frame).toContain('conversational');
  });

  it('renders keyboard hints', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(
      <App store={store} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Ctrl+C');
  });

  it('shows dashboard stub when mode is dashboard', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('dashboard');
    const { lastFrame } = render(
      <App store={store} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Dashboard mode');
  });
});
