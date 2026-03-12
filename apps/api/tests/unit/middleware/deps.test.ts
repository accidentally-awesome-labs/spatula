import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { depsMiddleware } from '../../../src/middleware/deps.js';
import type { AppDeps } from '../../../src/types.js';

describe('depsMiddleware', () => {
  it('injects deps into context', async () => {
    const mockDeps = { jobRepo: { findById: vi.fn() } } as unknown as AppDeps;
    const app = new Hono();
    app.use('*', depsMiddleware(mockDeps));
    app.get('/test', (c) => {
      const deps = c.get('deps');
      return c.json({ hasDeps: !!deps });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasDeps).toBe(true);
  });
});
