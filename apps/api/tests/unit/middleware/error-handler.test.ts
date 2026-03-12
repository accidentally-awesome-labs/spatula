import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  errorHandler,
  NotFoundError,
  ConflictError,
} from '../../../src/middleware/error-handler.js';
import { ValidationError, StorageError } from '@spatula/shared';

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
});
