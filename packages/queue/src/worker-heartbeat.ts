import { hostname } from 'node:os';
import type Redis from 'ioredis';
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';

const logger = createLogger('worker-heartbeat');

export interface HeartbeatConfig {
  redis: Redis;
  queues: string[];
  intervalMs?: number;
  ttlSeconds?: number;
}

export class WorkerHeartbeat {
  private readonly workerId: string;
  private readonly redis: Redis;
  private readonly queues: string[];
  private readonly intervalMs: number;
  private readonly ttlSeconds: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAt: number;

  constructor(config: HeartbeatConfig) {
    this.workerId = `${hostname()}-${process.pid}`;
    this.redis = config.redis;
    this.queues = config.queues;
    this.intervalMs = config.intervalMs ?? 30_000;
    this.ttlSeconds = config.ttlSeconds ?? 90;
    this.startedAt = Date.now();
  }

  start(): void {
    this.beat();
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref();
    logger.info({ workerId: this.workerId, queues: this.queues }, 'Heartbeat started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const key = `worker:heartbeat:${this.workerId}`;
    this.redis.del(key).catch(() => {});
    logger.info({ workerId: this.workerId }, 'Heartbeat stopped');
  }

  private beat(): void {
    const key = `worker:heartbeat:${this.workerId}`;
    const value = JSON.stringify({
      workerId: this.workerId,
      queues: this.queues,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      activeJobs: 0, // Wired to actual count in future
      lastBeat: new Date().toISOString(),
    });
    this.redis.set(key, value, 'EX', this.ttlSeconds).catch((err) => {
      logger.warn({ err, workerId: this.workerId }, 'Heartbeat write failed');
    });
  }
}
