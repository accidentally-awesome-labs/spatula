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

import { parseWSMessage, applyWSMessageToStore } from '../../../src/hooks/useWebSocket.js';
import type { CliStore } from '../../../src/store/index.js';

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

    expect(store._state.setRecentActions).toHaveBeenCalled();
    expect(store._state.setPendingActions).toHaveBeenCalled();
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

    expect(store._state.setEntityPreviews).toHaveBeenCalled();
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

afterEach(() => {
  mockWsInstances.length = 0;
});
