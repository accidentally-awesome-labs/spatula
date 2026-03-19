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
    try {
      await this.redis.publish(channelForJob(jobId), JSON.stringify(full));
    } catch (err) {
      // Fire-and-forget: event publishing should never crash a worker
      logger.warn({ jobId, type: event.type, err }, 'failed to publish event');
    }
  }
}

// ─── No-op implementation (for tests / disabled mode) ──────────

export class NoopEventPublisher implements EventPublisher {
  async publish(): Promise<void> {
    // intentionally empty
  }
}
