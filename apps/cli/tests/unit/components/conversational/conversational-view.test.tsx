import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ConversationalView } from '../../../../src/components/conversational/ConversationalView.js';
import { createCliStore } from '../../../../src/store/index.js';

describe('ConversationalView', () => {
  const noop = vi.fn();

  it('renders both chat and config panels', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(
      <ConversationalView store={store} onStartJob={noop} />,
    );
    const frame = lastFrame()!;
    // ChatView welcome text
    expect(frame).toContain('Describe');
    // ConfigPanel title
    expect(frame).toContain('Config');
  });

  it('shows config panel with updated state', () => {
    const store = createCliStore('test-tenant');
    store.getState().applyActions([
      { type: 'set_job_name', payload: { name: 'Recipe Scraper' } },
    ]);
    const { lastFrame } = render(
      <ConversationalView store={store} onStartJob={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Recipe Scraper');
  });
});
