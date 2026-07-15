import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import { channelForJob } from '@accidentally-awesome-labs/spatula-queue';
import type { JobEvent } from '@accidentally-awesome-labs/spatula-queue';
import type Redis from 'ioredis';
import type { WSMessage } from './types.js';

const logger = createLogger('ws:job-progress');

const WS_OPEN = 1;

interface ClientEntry {
  ws: { send(data: string): void; close(): void; readyState: number };
  tenantId: string;
}

export class JobProgressManager {
  /** jobId -> set of connected clients */
  private clients = new Map<string, Set<ClientEntry>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: Redis) {
    redis.on('message', (channel: string, message: string) => {
      this.handleRedisMessage(channel, message);
    });
  }

  async addClient(jobId: string, tenantId: string, ws: ClientEntry['ws']): Promise<void> {
    const entry: ClientEntry = { ws, tenantId };

    if (!this.clients.has(jobId)) {
      this.clients.set(jobId, new Set());
      await this.redis.subscribe(channelForJob(jobId));
      logger.debug({ jobId }, 'subscribed to job events');
    }

    this.clients.get(jobId)!.add(entry);
    this.startHeartbeat();

    const msg: WSMessage = {
      type: 'connected',
      timestamp: Date.now(),
      data: { jobId },
    };
    this.safeSend(ws, msg);
  }

  async removeClient(jobId: string, ws: ClientEntry['ws']): Promise<void> {
    const clients = this.clients.get(jobId);
    if (!clients) return;

    for (const entry of clients) {
      if (entry.ws === ws) {
        clients.delete(entry);
        break;
      }
    }

    if (clients.size === 0) {
      this.clients.delete(jobId);
      await this.redis.unsubscribe(channelForJob(jobId));
      logger.debug({ jobId }, 'unsubscribed from job events');
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  private handleRedisMessage(_channel: string, message: string): void {
    let event: JobEvent;
    try {
      event = JSON.parse(message);
    } catch {
      logger.warn({ channel: _channel }, 'received non-JSON message on event channel');
      return;
    }

    const clients = this.clients.get(event.jobId);
    if (!clients) return;

    const wsMessage: WSMessage = {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    };

    for (const entry of clients) {
      if (entry.tenantId !== event.tenantId) continue;
      this.safeSend(entry.ws, wsMessage);
    }
  }

  private safeSend(ws: ClientEntry['ws'], msg: WSMessage): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err }, 'failed to send WebSocket message');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      const ping: WSMessage = { type: 'ping', timestamp: Date.now(), data: {} };
      for (const clients of this.clients.values()) {
        for (const entry of clients) {
          this.safeSend(entry.ws, ping);
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        try {
          client.ws.close();
        } catch {
          // Client may already be disconnected
        }
      }
      clients.clear();
    }
    this.clients.clear();
  }
}
