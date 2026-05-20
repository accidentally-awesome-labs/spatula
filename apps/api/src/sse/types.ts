/**
 * SSE module types — mirrors apps/api/src/ws/types.ts layout.
 * The SSE id: field is the Redis stream id verbatim ({ms}-{seq}).
 */

/** A single SSE frame to be written via stream.writeSSE() */
export interface SSEEventFrame {
  id: string;
  event?: string;
  data: string; // JSON-serialised JobEvent (or synthetic payload)
}

/** Payload of the synthetic replay_truncated event */
export interface ReplayTruncatedPayload {
  requestedId: string;
  oldestAvailableId: string;
}

/** The SSE event name for the replay-truncation synthetic event */
export const REPLAY_TRUNCATED_EVENT = 'replay_truncated' as const;
