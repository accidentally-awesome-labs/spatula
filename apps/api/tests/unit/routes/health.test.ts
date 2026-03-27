import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { healthRoutes } from '../../../src/routes/health.js';
import type { Pool } from 'pg';

describe('Health routes', () => {
  describe('GET /health/live', () => {
    it('returns 200 with status ok', async () => {
      const app = new Hono();
      app.route('', healthRoutes({} as any));
      const res = await app.request('/health/live');
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when all checks pass', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockResolvedValue({}) } as unknown as Pool,
        redis: { ping: vi.fn().mockResolvedValue('PONG') } as any,
        queues: { crawl: { getJobCounts: vi.fn().mockResolvedValue({ waiting: 0 }) } } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.checks.database).toBe('ok');
    });

    it('returns 503 when database fails', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockRejectedValue(new Error('down')) } as unknown as Pool,
        redis: { ping: vi.fn().mockResolvedValue('PONG') } as any,
        queues: { crawl: { getJobCounts: vi.fn().mockResolvedValue({}) } } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.database).toBe('fail');
    });

    it('returns 503 when Redis ping fails', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockResolvedValue({}) } as unknown as Pool,
        redis: { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any,
        queues: { crawl: { getJobCounts: vi.fn().mockResolvedValue({}) } } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.redis).toBe('fail');
      expect(body.checks.database).toBe('ok');
    });

    it('returns 503 when queue getJobCounts fails', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockResolvedValue({}) } as unknown as Pool,
        redis: { ping: vi.fn().mockResolvedValue('PONG') } as any,
        queues: { crawl: { getJobCounts: vi.fn().mockRejectedValue(new Error('queue error')) } } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.queue).toBe('fail');
      expect(body.checks.database).toBe('ok');
      expect(body.checks.redis).toBe('ok');
    });

    it('returns 503 when ALL checks fail', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as Pool,
        redis: { ping: vi.fn().mockRejectedValue(new Error('redis down')) } as any,
        queues: { crawl: { getJobCounts: vi.fn().mockRejectedValue(new Error('queue down')) } } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.database).toBe('fail');
      expect(body.checks.redis).toBe('fail');
      expect(body.checks.queue).toBe('fail');
    });
  });
});
