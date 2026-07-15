/**
 * RedisStreamBuffer — thin wrapper over ioredis Streams commands so the SSE
 * handler stays thin and unit-testable.
 *
 * Stream key: jobs:{jobId}:events
 * Field layout: ['payload', <json>]
 *
 * Redis stream notes:
 *   - XADD MAXLEN ~ needs string args ('~', '500')
 *   - Code Example: XRANGE exclusive lower bound '(' prefix (Redis 6.2+)
 *   - XREAD BLOCK is called on a dedicated connection passed in by the handler;
 *     this class never touches the shared deps.redis connection.
 */
import type Redis from 'ioredis';
import type { JobEvent } from '@accidentally-awesome-labs/spatula-queue';

export class RedisStreamBuffer {
  private readonly streamKey: string;

  constructor(
    private readonly redis: Redis,
    jobId: string,
  ) {
    this.streamKey = `jobs:${jobId}:events`;
  }

  /**
   * Replay events from the stream.
   *
   * If `lastEventId` is provided, uses an EXCLUSIVE lower bound `(lastEventId`
   * so the client resumes strictly after that id (Redis 6.2+ feature).
   * Otherwise replays from the beginning of the stream (`-`).
   *
   * Returns an array of [id, fields] pairs where fields = ['payload', jsonStr].
   */
  async replayFrom(lastEventId?: string): Promise<[string, string[]][]> {
    const start = lastEventId ? `(${lastEventId}` : '-';
    const raw = await this.redis.xrange(this.streamKey, start, '+');
    // ioredis returns Array<[id, fields[]]>
    return raw as [string, string[]][];
  }

  /**
   * Returns the id of the oldest entry currently in the stream, or null if
   * the stream does not exist / is empty.
   *
   * Used to construct the replay_truncated payload when the client's
   * Last-Event-ID predates the oldest buffered entry.
   */
  async oldestId(): Promise<string | null> {
    const raw = await this.redis.xrange(this.streamKey, '-', '+', 'COUNT', '1');
    if (!raw || raw.length === 0) return null;
    // ioredis: first element is [id, fields[]]
    return (raw[0] as [string, string[]])[0];
  }

  /**
   * Block-wait for new entries after `cursor`.
   *
   * Returns [id, fields][] entries or null when the blocking period expires
   * without new events (the caller interprets null as a keepalive tick).
   *
   * CRITICAL: must be called on a dedicated Redis connection.
   *
   * @param cursor - stream id to start reading after (use '$' for live-only)
   * @param blockMs - how long to block (15 000 matches the keepalive interval)
   */
  async tail(cursor: string, blockMs: number): Promise<[string, string[]][] | null> {
    const result = await this.redis.xread(
      'BLOCK' as never,
      blockMs as never,
      'STREAMS' as never,
      this.streamKey as never,
      cursor as never,
    );
    if (!result) return null;
    // ioredis returns [[streamKey, [[id, fields[]], ...]]]
    const [[, entries]] = result as [[string, [string, string[]][]]];
    return entries as [string, string[]][];
  }

  /**
   * Parse a Redis stream fields array to a JobEvent.
   * Fields layout: ['payload', '<json>']
   */
  static parsePayload(fields: string[]): JobEvent {
    // fields is ['payload', '<json>']
    const json = fields[1];
    if (!json) throw new Error('SSE stream entry missing payload field');
    return JSON.parse(json) as JobEvent;
  }
}
