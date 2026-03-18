import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('ink-spinner', () => ({
  default: () => React.createElement('ink-text', null, '*'),
}));

import { App } from '../../../src/components/App.js';
import { createCliStore } from '../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../src/api/client.js';

function createMockApiClient(): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running', stats: {} }),
    listActions: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    pauseJob: vi.fn().mockResolvedValue({}),
    resumeJob: vi.fn().mockResolvedValue({}),
    cancelJob: vi.fn().mockResolvedValue({}),
    approveAction: vi.fn().mockResolvedValue({}),
    rejectAction: vi.fn().mockResolvedValue({}),
    approveAllActions: vi.fn().mockResolvedValue([]),
    createJob: vi.fn().mockResolvedValue({ id: 'job-new' }),
    startJob: vi.fn().mockResolvedValue({}),
  } as unknown as SpatulaApiClient;
}

describe('new command (interactive conversational mode)', () => {
  const noop = vi.fn();

  it('renders in conversational mode by default', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('conversational');
    expect(frame).toContain('Spatula');
  });

  it('displays welcome message when added to store', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    // Simulate what runNewCommand does: add a welcome message
    store.getState().addMessage({
      role: 'assistant',
      content:
        'Welcome to Spatula! Tell me what data you want to collect and I\'ll help you set up a crawl job.',
    });

    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Welcome to Spatula');
  });

  it('shows config panel alongside chat in conversational mode', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    // Conversational mode shows both chat and config panels
    expect(frame).toContain('Config');
  });

  it('reflects config changes from applied actions', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    // Simulate AI applying a set_job_name action
    store.getState().applyActions([
      { type: 'set_job_name', payload: { name: 'Product Scraper' } },
    ]);

    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Product Scraper');
  });
});
