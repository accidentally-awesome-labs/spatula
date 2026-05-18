import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket before importing the hook
const mockWsInstances: any[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((evt: any) => void) | null = null;
  onmessage: ((evt: any) => void) | null = null;
  onclose: ((evt: any) => void) | null = null;
  onerror: ((evt: any) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  _message(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  _error() {
    this.onerror?.({});
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

import {
  parseWSMessage,
  applyWSMessageToStore,
  useWebSocket,
  buildWsUrl,
} from '../../../src/hooks/useWebSocket.js';
import type { CliStore } from '../../../src/store/index.js';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

function createMockStore() {
  const state = {
    setJobData: vi.fn(),
    setPendingActions: vi.fn(),
    setRecentActions: vi.fn(),
    setSchemaData: vi.fn(),
    setEntityPreviews: vi.fn(),
    jobData: { status: 'running' },
    pendingActions: [],
    recentActions: [],
    schemaData: { version: 1 },
    entityPreviews: [],
  };
  return {
    getState: vi.fn().mockReturnValue(state),
    _state: state,
  } as unknown as CliStore & { _state: typeof state };
}

describe('parseWSMessage', () => {
  it('parses valid JSON message', () => {
    const msg = parseWSMessage(JSON.stringify({ type: 'crawl_progress', timestamp: 1, data: {} }));
    expect(msg).toEqual({ type: 'crawl_progress', timestamp: 1, data: {} });
  });

  it('returns null for invalid JSON', () => {
    expect(parseWSMessage('not json')).toBeNull();
  });

  it('returns null for message missing type', () => {
    expect(parseWSMessage(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe('applyWSMessageToStore', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  it('updates jobData status on job_status_changed', () => {
    applyWSMessageToStore(store, {
      type: 'job_status_changed',
      timestamp: Date.now(),
      data: { from: 'running', to: 'paused' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('appends to recentActions and pendingActions on action_pending', () => {
    applyWSMessageToStore(store, {
      type: 'action_pending',
      timestamp: Date.now(),
      data: { actionId: 'a-1', type: 'add_field', confidence: 0.9 },
    });

    const recentCall = (store._state.setRecentActions as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(recentCall).toHaveLength(1);
    expect(recentCall[0]).toMatchObject({ id: 'a-1', type: 'add_field' });
    const pendingCall = (store._state.setPendingActions as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(pendingCall).toHaveLength(1);
    expect(pendingCall[0]).toMatchObject({ id: 'a-1' });
  });

  it('updates schemaData on schema_evolved', () => {
    applyWSMessageToStore(store, {
      type: 'schema_evolved',
      timestamp: Date.now(),
      data: { version: 2, fieldsAdded: ['color'], fieldsMerged: [] },
    });

    expect(store._state.setSchemaData).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
  });

  it('appends to entityPreviews on entity_created', () => {
    applyWSMessageToStore(store, {
      type: 'entity_created',
      timestamp: Date.now(),
      data: { entityId: 'e-1', name: 'Test Entity' },
    });

    const previewCall = (store._state.setEntityPreviews as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(previewCall).toHaveLength(1);
    expect(previewCall[0]).toMatchObject({ id: 'e-1', name: 'Test Entity' });
  });

  it('increments pagesCrawled on task_completed', () => {
    store._state.jobData = { status: 'running', pagesCrawled: 5 };
    applyWSMessageToStore(store, {
      type: 'task_completed',
      timestamp: Date.now(),
      data: { taskId: 't-1', url: 'https://example.com/page', classification: 'single_entry' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ pagesCrawled: 6 }),
    );
  });

  it('initializes pagesCrawled from zero when not present', () => {
    store._state.jobData = { status: 'running' };
    applyWSMessageToStore(store, {
      type: 'task_completed',
      timestamp: Date.now(),
      data: { taskId: 't-1', url: 'https://example.com/page', classification: 'single_entry' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ pagesCrawled: 1 }),
    );
  });

  it('accumulates pagesQueued on crawl_progress', () => {
    store._state.jobData = { status: 'running', pagesQueued: 10 };
    applyWSMessageToStore(store, {
      type: 'crawl_progress',
      timestamp: Date.now(),
      data: { pagesFound: 3, taskId: 't-1', url: 'https://example.com/page' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ pagesQueued: 13 }),
    );
  });

  it('ignores crawl_progress when pagesFound is not a number', () => {
    store._state.jobData = { status: 'running' };
    applyWSMessageToStore(store, {
      type: 'crawl_progress',
      timestamp: Date.now(),
      data: { taskId: 't-1', url: 'https://example.com/page' },
    });

    expect(store._state.setJobData).not.toHaveBeenCalled();
  });

  it('does not throw on unknown event type', () => {
    expect(() =>
      applyWSMessageToStore(store, {
        type: 'connected' as any,
        timestamp: Date.now(),
        data: { heartbeat: true },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// useWebSocket hook — lifecycle tests
// ---------------------------------------------------------------------------

function WsTestComponent({
  store,
  baseUrl,
  tenantId,
  jobId,
  token,
}: {
  store: ReturnType<typeof createMockStore>;
  baseUrl: string;
  tenantId: string;
  jobId: string;
  token?: string;
}) {
  const { connected, error } = useWebSocket(store, baseUrl, tenantId, jobId, token);
  return React.createElement(
    Text,
    null,
    `${connected ? 'connected' : 'disconnected'}|${error ?? 'none'}`,
  );
}

describe('useWebSocket hook', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('connects to WebSocket with tenantId URL when no token', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    // Flush React useEffect
    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toBe(
      'ws://localhost:3000/ws/jobs/job-1/progress?tenantId=tenant-1',
    );
  });

  it('connects with token URL when token is provided', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'https://api.example.com',
        tenantId: '',
        jobId: 'job-1',
        token: 'tok_abc',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toBe(
      'wss://api.example.com/ws/jobs/job-1/progress?token=tok_abc',
    );
  });

  it('does not connect when jobId is empty', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: '',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(0);
  });

  it('does not connect when baseUrl is empty', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: '',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(0);
  });

  it('dispatches messages to store on onmessage', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    const ws = mockWsInstances[0];
    ws._open();
    ws._message({
      type: 'job_status_changed',
      timestamp: Date.now(),
      data: { from: 'running', to: 'completed' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('attempts reconnection with exponential backoff on close', async () => {
    render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(1);
    const ws1 = mockWsInstances[0];
    ws1._open();
    ws1._close(); // Trigger reconnect — delay is 1s, then bumps to 2s

    // After 1s delay, should reconnect
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockWsInstances).toHaveLength(2);

    // Close again without opening — backoff should be 2s since _open() resets it
    const ws2 = mockWsInstances[1];
    ws2._close();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockWsInstances).toHaveLength(2); // Not yet — need 2s total
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockWsInstances).toHaveLength(3); // Now reconnected after 2s
  });

  it('cleans up WebSocket on unmount', async () => {
    const { unmount } = render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(1);
    const ws = mockWsInstances[0];
    ws._open();
    await vi.advanceTimersByTimeAsync(0);

    unmount();
    // Flush any pending React cleanup
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.close).toHaveBeenCalled();
  });

  it('does not reconnect after unmount', async () => {
    const { unmount } = render(
      React.createElement(WsTestComponent, {
        store,
        baseUrl: 'http://localhost:3000',
        tenantId: 'tenant-1',
        jobId: 'job-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    const ws = mockWsInstances[0];
    ws._open();
    await vi.advanceTimersByTimeAsync(0);

    unmount();
    await vi.advanceTimersByTimeAsync(0);
    ws._close(); // Simulate close after unmount

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsInstances).toHaveLength(1); // No reconnect attempted
  });
});

afterEach(() => {
  mockWsInstances.length = 0;
});
