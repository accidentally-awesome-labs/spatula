/**
 * SSE streaming subscription to job events. GET /api/v1/jobs/:id/events.
 *
 * - In the browser: uses native `window.EventSource`.
 * - In Node (no `window`): dynamically imports the `eventsource` polyfill
 *   (guarded import so the browser bundle never includes it).
 *
 * The server emits SSE frames with:
 *   id:    Redis stream id (`{ms}-{seq}`)
 *   data:  JSON-encoded JobEvent
 *   event: `replay_truncated` when Last-Event-ID is too old
 *
 * Auth: `token` is a single-use stream token obtained from
 * `POST /api/v1/ws-token`. It is passed as a `?token=` query param because
 * EventSource does not support custom headers.
 *
 * Phase 17 replaces the Phase 16 non-streaming stub. The old `getJobEvents`
 * (returns `Promise<JobEvent[]>`) is kept as a thin compatibility shim for
 * any callers that were using it; prefer `subscribeJobEvents` for new code.
 */

/** Minimal SpatulaClient shape needed by this module (avoids circular import). */
export interface ClientLike {
  baseUrl: string;
}

// Declare `window` as a possibly-undefined global to allow the Node/browser
// guard `typeof window === 'undefined'` without requiring `lib: ["DOM"]`.
declare const window: Record<string, unknown> | undefined;

/**
 * Minimal EventSource interface — defined here to avoid requiring `lib: ["DOM"]`
 * in the tsconfig. Both the native browser EventSource and the `eventsource@4.1.0`
 * polyfill satisfy this shape at runtime.
 */
interface MinimalEventSource {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, fn: (e: Event) => void): void;
  close(): void;
}

export interface JobEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/** Payload delivered with a `replay_truncated` SSE event. */
export interface ReplayTruncatedPayload {
  /** The Last-Event-ID that was requested but is no longer in the buffer. */
  requestedId: string;
  /** The oldest event id still available in the buffer. */
  oldestAvailableId: string;
}

export interface SubscribeJobEventsOptions {
  /** Callback for each job event frame. */
  onEvent: (event: JobEvent) => void;
  /** Optional error handler wired to `es.onerror`. */
  onError?: (err: Event) => void;
  /**
   * Optional callback when the server emits a `replay_truncated` named event
   * (i.e., the requested `lastEventId` has fallen off the 5-min ring buffer).
   */
  onReplayTruncated?: (payload: ReplayTruncatedPayload) => void;
  /**
   * Last event id for resume — passed as `?lastEventId=` query param.
   * When provided the server replays buffered events strictly AFTER this id.
   */
  lastEventId?: string;
  /**
   * Single-use stream token obtained from `POST /api/v1/ws-token`.
   * Passed as `?token=` because EventSource cannot set custom headers.
   */
  token: string;
}

/** Returns an unsubscribe function that closes the EventSource connection. */
export type UnsubscribeFn = () => void;

/**
 * Subscribe to real-time job events via Server-Sent Events.
 *
 * Returns an unsubscribe function. Call it to close the SSE connection.
 *
 * ```ts
 * const unsubscribe = subscribeJobEvents(client, jobId, {
 *   token,
 *   lastEventId: lastSeen,       // optional — for resume after reconnect
 *   onEvent: (evt) => console.log(evt),
 *   onReplayTruncated: (p) => console.warn('buffer gap', p),
 * });
 * // later …
 * unsubscribe();
 * ```
 */
export function subscribeJobEvents(
  client: ClientLike,
  jobId: string,
  options: SubscribeJobEventsOptions,
): UnsubscribeFn {
  // Build the SSE URL.
  const url = new URL(`${client.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/events`);
  url.searchParams.set('token', options.token);
  if (options.lastEventId) {
    url.searchParams.set('lastEventId', options.lastEventId);
  }

  // Resolve the EventSource constructor.
  // In the browser the global `window.EventSource` is used directly.
  // In Node (typeof window === 'undefined') the `eventsource` polyfill is
  // dynamically imported to keep it OUT of the browser bundle. The function
  // is synchronous but the Node polyfill path wraps construction in a resolved
  // Promise so the EventSource is created asynchronously on the next tick.

  let es: MinimalEventSource | undefined;
  let closed = false;

  if (typeof window === 'undefined') {
    // Node path: dynamic import — polyfill stays outside the browser bundle.

    import('eventsource').then(({ EventSource: NodeEventSource }) => {
      if (closed) return; // unsubscribed before polyfill loaded
      // eventsource@4.1.0 is W3C-compliant; cast through unknown to our minimal interface.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      es = new (NodeEventSource as any)(url.toString()) as MinimalEventSource;
      wireHandlers(es, options);
    });
  } else {
    // Browser path: native EventSource (accessed via globalThis to avoid requiring DOM lib).

    const NativeES = (globalThis as Record<string, unknown>)['EventSource'] as new (
      url: string,
    ) => MinimalEventSource;
    es = new NativeES(url.toString());
    wireHandlers(es, options);
  }

  return () => {
    closed = true;
    es?.close();
  };
}

function wireHandlers(es: MinimalEventSource, options: SubscribeJobEventsOptions): void {
  es.onmessage = (e: MessageEvent) => {
    try {
      const evt = JSON.parse(e.data as string) as JobEvent;
      // The SSE protocol delivers the frame's `id:` line as `e.lastEventId`.
      // The server sets this to the Redis stream id. Inject it into the event
      // object so callers can record the last-seen id for Last-Event-ID resume.
      // (The JSON payload itself has no `id` field — it is a @spatula/queue
      // JobEvent whose identity is carried only in the SSE frame header.)
      if (e.lastEventId) evt.id = e.lastEventId;
      options.onEvent(evt);
    } catch {
      // Malformed frame — silently ignore; callers can detect gaps via event ids.
    }
  };

  if (options.onError) {
    es.onerror = options.onError;
  }

  if (options.onReplayTruncated) {
    const handler = options.onReplayTruncated;
    es.addEventListener('replay_truncated', (e: Event) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data as string) as ReplayTruncatedPayload;
        handler(payload);
      } catch {
        // Malformed replay_truncated payload — ignore.
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Compatibility shim — Phase 16 non-streaming stub kept for backward compat.
// ---------------------------------------------------------------------------

import type { SpatulaClient } from '../client.js';

/**
 * @deprecated Use `subscribeJobEvents` for real SSE streaming. This non-
 * streaming shim is kept for backward compatibility with Phase 16 code that
 * imported `getJobEvents`. It issues a plain JSON GET (not SSE).
 */
export async function getJobEvents(
  client: SpatulaClient,
  jobId: string,
  params: { lastEventId?: string } = {},
): Promise<JobEvent[]> {
  const query = new URLSearchParams();
  if (params.lastEventId) query.set('lastEventId', params.lastEventId);
  const qs = query.toString();
  return client.request<JobEvent[]>(
    'GET',
    `/api/v1/jobs/${encodeURIComponent(jobId)}/events${qs ? `?${qs}` : ''}`,
  );
}
