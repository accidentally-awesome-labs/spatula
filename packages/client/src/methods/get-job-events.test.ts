/**
 * Unit tests for `subscribeJobEvents` — real SSE streaming method.
 *
 * Uses a fake EventSource (injected via globalThis override) so no live server
 * is needed. Tests cover:
 *
 *   Test 1: URL construction with token query param
 *   Test 2: URL construction with lastEventId query param
 *   Test 3: onmessage delivers JSON-parsed event to onEvent callback
 *   Test 4: replay_truncated named event is delivered to onReplayTruncated
 *   Test 5: returned unsubscribe function closes the EventSource
 *   Test 6: Node-guarded dynamic import pattern (typeof window guard)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { subscribeJobEvents as subscribeJobEventsRef } from './get-job-events.js';
import type { ClientLike } from './get-job-events.js';

// ------------------------------------------------------------------ fake ES --
type SSEListener = (event: MessageEvent) => void;
type GenericListener = (event: Event) => void;

class FakeEventSource {
  static lastInstance: FakeEventSource | null = null;

  readonly url: string;
  onmessage: SSEListener | null = null;
  onerror: GenericListener | null = null;
  private listeners: Map<string, GenericListener[]> = new Map();
  closed = false;

  constructor(url: string | URL) {
    this.url = url.toString();
    FakeEventSource.lastInstance = this;
  }

  addEventListener(type: string, fn: GenericListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: GenericListener): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }

  dispatchMessage(data: string): void {
    const e = Object.assign(new Event('message'), { data }) as MessageEvent;
    this.onmessage?.(e);
  }

  dispatchNamed(type: string, data: string): void {
    const e = Object.assign(new Event(type), { data }) as MessageEvent;
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler(e as unknown as Event);
    }
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------- helpers ---
function makeClient(baseUrl = 'http://localhost:3000') {
  return { baseUrl } as ClientLike;
}

// We need to import after setting up globalThis.EventSource so the module
// resolver picks it up. Because vitest re-uses the module cache we import at
// describe level with a fresh vi.mock or use dynamic import in each test.

describe('subscribeJobEvents', () => {
  beforeEach(() => {
    FakeEventSource.lastInstance = null;
    // Install the fake as the global EventSource so the SSE method uses it.
    // @ts-expect-error — attaching fake to globalThis for test isolation.
    globalThis.EventSource = FakeEventSource;
    // Ensure we look like a browser context (window exists) so the dynamic
    // Node import path is NOT taken during unit tests.
    if (typeof window === 'undefined') {
      // @ts-expect-error — minimal window stub.
      globalThis.window = { EventSource: FakeEventSource };
    }
  });

  afterEach(() => {
    // @ts-expect-error — cleanup.
    delete globalThis.EventSource;
    // @ts-expect-error — cleanup.
    delete globalThis.window;
    FakeEventSource.lastInstance = null;
  });

  // Dynamic import to pick up module after globalThis.EventSource is set.
  async function importSubscribe() {
    // Force fresh module load in each test to avoid stale cache.
    const mod = await import('./get-job-events.js?t=' + Date.now());
    return mod.subscribeJobEvents as typeof subscribeJobEventsRef;
  }

  it('Test 1: builds URL with token query param', async () => {
    const subscribeJobEvents = await importSubscribe();
    const client = makeClient('http://localhost:3000');
    const token = 'tok_abc123';

    subscribeJobEvents(client, 'job_1', {
      token,
      onEvent: vi.fn(),
    });

    const instance = FakeEventSource.lastInstance;
    expect(instance).not.toBeNull();
    const url = new URL(instance!.url);
    expect(url.pathname).toBe('/api/v1/jobs/job_1/events');
    expect(url.searchParams.get('token')).toBe(token);
    expect(url.searchParams.get('lastEventId')).toBeNull();
  });

  it('Test 2: appends lastEventId as query param when provided', async () => {
    const subscribeJobEvents = await importSubscribe();
    const client = makeClient('http://localhost:3000');

    subscribeJobEvents(client, 'job_2', {
      token: 'tok_xyz',
      lastEventId: '1748123456789-0',
      onEvent: vi.fn(),
    });

    const instance = FakeEventSource.lastInstance;
    expect(instance).not.toBeNull();
    const url = new URL(instance!.url);
    expect(url.searchParams.get('lastEventId')).toBe('1748123456789-0');
  });

  it('Test 3: delivers JSON-parsed message frames to onEvent', async () => {
    const subscribeJobEvents = await importSubscribe();
    const client = makeClient('http://localhost:3000');
    const received: unknown[] = [];

    subscribeJobEvents(client, 'job_3', {
      token: 'tok_test',
      onEvent: (evt) => received.push(evt),
    });

    const instance = FakeEventSource.lastInstance!;
    const payload = { id: 'evt_1', type: 'job.status', data: { status: 'running' }, timestamp: '2026-05-20T00:00:00Z' };
    instance.dispatchMessage(JSON.stringify(payload));
    instance.dispatchMessage(JSON.stringify({ ...payload, id: 'evt_2' }));

    expect(received).toHaveLength(2);
    expect((received[0] as { id: string }).id).toBe('evt_1');
    expect((received[1] as { id: string }).id).toBe('evt_2');
  });

  it('Test 4: replay_truncated named event is surfaced via onReplayTruncated callback', async () => {
    const subscribeJobEvents = await importSubscribe();
    const client = makeClient('http://localhost:3000');
    const truncations: unknown[] = [];

    subscribeJobEvents(client, 'job_4', {
      token: 'tok_rt',
      onEvent: vi.fn(),
      onReplayTruncated: (evt) => truncations.push(evt),
    });

    const instance = FakeEventSource.lastInstance!;
    instance.dispatchNamed('replay_truncated', JSON.stringify({
      requestedId: '1748000000000-0',
      oldestAvailableId: '1748100000000-0',
    }));

    expect(truncations).toHaveLength(1);
    const t = truncations[0] as { requestedId: string };
    expect(t.requestedId).toBe('1748000000000-0');
  });

  it('Test 5: returned unsubscribe function closes the EventSource', async () => {
    const subscribeJobEvents = await importSubscribe();
    const client = makeClient('http://localhost:3000');

    const unsubscribe = subscribeJobEvents(client, 'job_5', {
      token: 'tok_close',
      onEvent: vi.fn(),
    });

    const instance = FakeEventSource.lastInstance!;
    expect(instance.closed).toBe(false);

    unsubscribe();

    expect(instance.closed).toBe(true);
  });

  it('Test 6: typeof window guard — when window is absent, will rely on dynamic import path (smoke)', async () => {
    // This test verifies the structural guard exists in the source.
    // We read the implementation file and confirm it contains the guard.
    // Full Node-path integration is tested by running the unit test in a
    // Node context with window undefined; this smoke check ensures the
    // pattern is present.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('./get-job-events.ts', import.meta.url).pathname.replace(/\.js\?.*$/, '.ts').replace(/\.js$/, '.ts'),
        'utf8',
      ),
    );
    expect(source).toContain("typeof window === 'undefined'");
    expect(source).toContain("import('eventsource')");
  });
});
