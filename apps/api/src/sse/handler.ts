/**
 * SSE route handler factory for GET /api/v1/jobs/:id/events.
 *
 * Flow:
 *   1. Consume single-use ?token= via GETDEL (mirrors server.ts WS token pattern)
 *   2. Validate tenant ownership via jobRepo.findById
 *   3. Set X-Accel-Buffering: no header (streamSSE auto-sets Content-Type + Cache-Control)
 *   4. Create DEDICATED ioredis connection for XREAD BLOCK (RESEARCH Pitfall 1)
 *   5. Replay buffered events via XRANGE, emit replay_truncated if stale
 *   6. Tail live events via XREAD BLOCK 15s on dedicated connection
 *   7. Emit :\n\n keepalive comments every 15s while idle
 *
 * Auth: The SSE path is on the auth-middleware skip-list (EventSource cannot send
 * Authorization headers). Token-based auth happens here in-handler via GETDEL.
 */
import { streamSSE } from 'hono/streaming';
import { Redis } from 'ioredis';
import { createLogger, AuthInvalidTokenError, AuthMissingTokenError, SpatulaError, ErrorCode } from '@spatula/shared';
import { RedisStreamBuffer } from './buffer.js';
import { REPLAY_TRUNCATED_EVENT } from './types.js';
import type { AppDeps } from '../types.js';
import type { Context } from 'hono';

const logger = createLogger('sse:handler');

const KEEPALIVE_INTERVAL_MS = 15_000;

export function createSseHandler(deps: AppDeps) {
  return async (c: Context) => {
    const jobId = c.req.param('id');
    const token = c.req.query('token');
    const lastEventId =
      c.req.header('last-event-id') ?? c.req.query('lastEventId');

    // ── Auth: consume single-use token via GETDEL ──────────────────────────
    if (!token) {
      throw new AuthMissingTokenError('Stream token required (use POST /api/v1/ws-token)');
    }

    if (!deps.redis) {
      throw new SpatulaError('Redis not configured', ErrorCode.INTERNAL_ERROR);
    }

    const value = await deps.redis.getdel(`ws-token:${token}`);
    if (!value) {
      throw new AuthInvalidTokenError('Invalid or expired stream token');
    }

    let tenantId: string;
    try {
      const parsed = JSON.parse(value) as { tenantId: string };
      tenantId = parsed.tenantId;
    } catch {
      throw new AuthInvalidTokenError('Corrupted stream token data');
    }

    // ── Ownership check ────────────────────────────────────────────────────
    const job = await deps.jobRepo.findById(jobId!, tenantId);
    if (!job) {
      throw new SpatulaError('Job not found', ErrorCode.RESOURCE_NOT_FOUND, {
        context: { resource: 'job' },
      });
    }

    // ── Response headers (before streamSSE call) ───────────────────────────
    // streamSSE auto-sets: Content-Type: text/event-stream, Cache-Control: no-cache
    // X-Accel-Buffering must be set manually (RESEARCH — streamSSE does NOT set it)
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache'); // belt-and-suspenders

    // ── Dedicated ioredis connection for XREAD BLOCK ───────────────────────
    // RESEARCH Pitfall 1: XREAD BLOCK monopolizes a connection. Never use
    // the shared deps.redis for blocking reads.
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    const streamRedis = new Redis(redisUrl, { lazyConnect: false });

    return streamSSE(
      c,
      async (stream) => {
        // Wire abort for Node.js (Bun gets this automatically, Node does not)
        c.req.raw.signal.addEventListener('abort', () => {
          if (!stream.closed) stream.abort();
        });

        let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

        stream.onAbort(() => {
          streamRedis.quit().catch(() => {});
          if (keepaliveTimer) clearInterval(keepaliveTimer);
        });

        // Keepalive: SSE comment line `:\n\n` every 15s (D-05)
        keepaliveTimer = setInterval(async () => {
          if (!stream.aborted) {
            await stream.write(':\n\n');
          }
        }, KEEPALIVE_INTERVAL_MS);

        // ── REPLAY ─────────────────────────────────────────────────────────
        const buffer = new RedisStreamBuffer(deps.redis!, jobId!);
        const replayed = await buffer.replayFrom(lastEventId);

        // Check for truncation: lastEventId given but no events found
        if (lastEventId && replayed.length === 0) {
          const oldestId = await buffer.oldestId();
          if (oldestId !== null) {
            // Emit replay_truncated synthetic event
            await stream.writeSSE({
              event: REPLAY_TRUNCATED_EVENT,
              id: oldestId,
              data: JSON.stringify({
                requestedId: lastEventId,
                oldestAvailableId: oldestId,
              }),
            });
          }
        }

        // Emit replayed events (tenant-filtered as defense-in-depth)
        for (const [id, fields] of replayed) {
          if (stream.aborted) break;
          try {
            const event = RedisStreamBuffer.parsePayload(fields);
            // Defense-in-depth tenant filter (ownership already verified above)
            if (event.tenantId !== tenantId) continue;
            await stream.writeSSE({ id, data: JSON.stringify(event) });
          } catch (err) {
            logger.warn({ jobId, id, err }, 'failed to parse replayed SSE entry');
          }
        }

        // ── TAIL: live events via XREAD BLOCK ──────────────────────────────
        // cursor: last replayed id, or '$' for live-only
        let cursor = replayed.length > 0 ? replayed.at(-1)![0] : '$';
        const tailBuffer = new RedisStreamBuffer(streamRedis, jobId!);

        while (!stream.aborted) {
          let entries: [string, string[]][] | null;
          try {
            entries = await tailBuffer.tail(cursor, KEEPALIVE_INTERVAL_MS);
          } catch (err) {
            if (stream.aborted) break;
            logger.warn({ jobId, err }, 'XREAD BLOCK error; retrying');
            continue;
          }

          if (entries === null) {
            // Timeout — keepalive timer handles the comment, just continue
            continue;
          }

          for (const [id, fields] of entries) {
            if (stream.aborted) break;
            try {
              const event = RedisStreamBuffer.parsePayload(fields);
              // Defense-in-depth tenant filter
              if (event.tenantId !== tenantId) continue;
              await stream.writeSSE({ id, data: JSON.stringify(event) });
              cursor = id;
            } catch (err) {
              logger.warn({ jobId, id, err }, 'failed to parse live SSE entry');
            }
          }
        }

        // Cleanup on normal exit
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        streamRedis.quit().catch(() => {});
      },
      async (err, stream) => {
        // onError callback: log and emit one error frame
        logger.error({ jobId, err }, 'SSE stream error');
        try {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: (err as Error).message }),
          });
        } catch {
          // stream may already be closed
        }
      },
    );
  };
}
