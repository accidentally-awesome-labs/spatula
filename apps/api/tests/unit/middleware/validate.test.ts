import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { validateBody, validateQuery } from '../../../src/middleware/validate.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

describe('validateBody', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('passes valid body to handler', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/test', validateBody(schema), (c) => {
      return c.json({ name: (c.get('validatedBody') as any).name });
    });

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('test');
  });

  it('returns 400 for invalid body', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/test', validateBody(schema), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION.SCHEMA');
  });

  it('returns 400 for non-JSON body', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/test', validateBody(schema), (c) => {
      return c.json({ ok: true });
    });

    const res = await app.request('/test', {
      method: 'POST',
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('validateQuery', () => {
  const schema = z.object({
    page: z.coerce.number().int().min(1).default(1),
  });

  it('passes valid query params', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get('/test', validateQuery(schema), (c) => {
      return c.json({ page: (c.get('validatedQuery') as any).page });
    });

    const res = await app.request('/test?page=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(2);
  });

  it('applies defaults for missing query params', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get('/test', validateQuery(schema), (c) => {
      return c.json({ page: (c.get('validatedQuery') as any).page });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
  });
});
