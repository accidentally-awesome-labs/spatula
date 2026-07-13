import { createLogger } from '@spatula/shared';
import type Redis from 'ioredis';

const logger = createLogger('events');

// ─── Event types ───────────────────────────────────────────────

export type JobEventType =
  | 'crawl_progress'
  | 'task_completed'
  | 'schema_evolved'
  | 'action_pending'
  | 'job_status_changed'
  | 'entity_created'
  | 'error';

export interface JobEvent {
  type: JobEventType;
  jobId: string;
  tenantId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export function channelForJob(jobId: string): string {
  return `spatula:events:${jobId}`;
}

// ─── Publisher interface ───────────────────────────────────────

export interface EventPublisher {
  publish(jobId: string, event: Omit<JobEvent, 'timestamp'>): Promise<void>;
}

// ─── Redis implementation ──────────────────────────────────────

export class RedisEventPublisher implements EventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(jobId: string, event: Omit<JobEvent, 'timestamp'>): Promise<void> {
    const full: JobEvent = { ...event, timestamp: Date.now() };
    const payload = JSON.stringify(full);

    // ── pub/sub (WS path) — unchanged ──────────────────────────────────────
    try {
      await this.redis.publish(channelForJob(jobId), payload);
    } catch (err) {
      // Fire-and-forget: event publishing should never crash a worker
      logger.warn({ jobId, type: event.type, err }, 'failed to publish event to pub/sub');
    }

    // ── Redis Stream (SSE path) — independent try/catch ─────────────────────
    // Stream key `jobs:{jobId}:events` is DISTINCT from `spatula:events:{jobId}`
    // (pub/sub channel); they must not collide.
    // MAXLEN ~ 500 (approx-trim), * = auto-id, field = payload.
    // EXPIRE is NOT auto-refreshed by XADD; refresh on every write.
    const streamKey = `jobs:${jobId}:events`;
    try {
      await this.redis.xadd(streamKey, 'MAXLEN', '~', '500', '*', 'payload', payload);
      await this.redis.expire(streamKey, 300);
    } catch (err) {
      logger.warn({ jobId, type: event.type, err }, 'failed to publish event to stream');
    }
  }
}

// ─── No-op implementation (for tests / disabled mode) ──────────

export class NoopEventPublisher implements EventPublisher {
  async publish(): Promise<void> {
    // intentionally empty
  }
}
