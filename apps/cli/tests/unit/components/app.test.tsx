import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../../src/components/App.js';
import { createCliStore } from '../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../src/api/client.js';

function createMockApiClient(): SpatulaApiClient {
  return {
    baseUrl: 'http://localhost:3000',
    tenantId: 'test-tenant',
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
  } as unknown as SpatulaApiClient;
}

describe('App', () => {
  const noop = vi.fn();

  it('renders header with current mode', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Spatula');
    expect(frame).toContain('conversational');
  });

  it('renders keyboard hints', () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    expect(lastFrame()!).toContain('Ctrl+C');
  });

  it('renders DashboardView when mode is dashboard and job is active', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('dashboard');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({
      id: 'job-1',
      name: 'Test Job',
      status: 'running',
      stats: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 0, pagesReconciled: 0, actionsPending: 0, actionsApplied: 0 },
    });

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    expect(lastFrame()!).toContain('Progress');
  });

  it('renders ReviewView when mode is review and job is active', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('review');
    store.getState().setActiveJobId('job-1');

    // Must also mock listActions to return same data since useJobPolling fires immediately
    const sampleActions = [
      { id: 'a1', type: 'add_field', confidence: 0.9, reasoning: 'test', source: 'schema_evolution', payload: { field: { name: 'x', type: 'string', description: '' } }, status: 'pending_review' },
    ];
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    // Make polling return the same actions so they don't get wiped
    (apiClient.listActions as ReturnType<typeof vi.fn>).mockResolvedValue(sampleActions);

    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    expect(lastFrame()!).toContain('add_field');
  });

  it('shows context-appropriate keyboard hints for dashboard mode', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('dashboard');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({ id: 'job-1', name: 'Test', status: 'running', stats: {} });

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Pause/Resume');
    expect(frame).toContain('Cancel');
  });

  it('renders ExplorerView in explorer mode', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('explorer');

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    // ExplorerView renders "No active job" when activeJobId is null
    expect(lastFrame()!).toContain('No active job');
  });

  it('switches from conversational to dashboard on D key', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({ id: 'job-1', name: 'Test', status: 'running', stats: {} });

    const apiClient = createMockApiClient();
    const { stdin, lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );

    // Wait for useInput to register
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('d');
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getState().mode).toBe('dashboard');
  });

  it('switches from conversational to review on R key', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    const sampleActions = [
      { id: 'a1', type: 'add_field', confidence: 0.9, reasoning: 'test', source: 'schema_evolution', payload: { field: { name: 'x', type: 'string', description: '' } }, status: 'pending_review' },
    ];
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    (apiClient.listActions as ReturnType<typeof vi.fn>).mockResolvedValue(sampleActions);

    const { stdin } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write('r');
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getState().mode).toBe('review');
  });
});
