import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));
vi.mock('@spatula/shared', async () => {
  const actual = await vi.importActual<typeof import('@spatula/shared')>('@spatula/shared');
  return { ...actual, captureException: mockCaptureException };
});

import {
  errorHandler,
  NotFoundError,
  ConflictError,
} from '../../../src/middleware/error-handler.js';
import {
  ValidationError,
  StorageError,
  QueueError,
  TimeoutError,
  RateLimitError,
  NetworkError,
  StateError,
} from '@spatula/shared';

function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  it('maps ValidationError to 400', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationError('bad input');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('bad input');
  });

  it('maps NotFoundError to 404', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new NotFoundError('Job', 'job-123');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps ConflictError to 409', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ConflictError('already exists');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('maps StorageError to 500', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new StorageError('db down');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('STORAGE_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });

  it('maps unknown errors to 500 with generic message', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('unexpected');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });

  it('maps QueueError to 503', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new QueueError('queue unavailable');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('QUEUE_ERROR');
  });

  it('maps TimeoutError to 504', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new TimeoutError('request timed out');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe('TIMEOUT_ERROR');
  });

  it('maps RateLimitError to 429', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new RateLimitError('too many requests');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT_ERROR');
  });

  it('maps NetworkError to 502', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new NetworkError('upstream unavailable');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('NETWORK_ERROR');
  });

  it('maps StateError to 409', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new StateError('invalid state transition');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_ERROR');
  });

  it('includes requestId in error response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('fail');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.requestId).toBeDefined();
    expect(typeof body.error.requestId).toBe('string');
  });

  describe('Sentry captureException', () => {
    it('calls captureException for 5xx errors', async () => {
      mockCaptureException.mockClear();
      const app = createTestApp();
      app.get('/test', () => {
        throw new StorageError('db crashed');
      });

      const res = await app.request('/test');
      expect(res.status).toBe(500);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(StorageError),
        expect.objectContaining({ path: '/test' }),
      );
    });

    it('does NOT call captureException for 4xx errors', async () => {
      mockCaptureException.mockClear();
      const app = createTestApp();
      app.get('/test', () => {
        throw new ValidationError('bad request');
      });

      const res = await app.request('/test');
      expect(res.status).toBe(400);
      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });
});
