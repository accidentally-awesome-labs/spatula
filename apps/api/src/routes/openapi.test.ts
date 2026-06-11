/**
 * Phase 16 plan 16-3 (Task 1) tests for the live OpenAPI 3.1 spec endpoint and
 * the boot-cache + dev-mode example validator helpers.
 *
 * Test strategy uses `Hono.request(path)` rather than a Node http.Server boot
 * (the carveout fixture pattern) because the route only depends on the in-
 * memory cached spec — no real DB or Redis is needed for these assertions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoute, z } from '@hono/zod-openapi';
import {
  _resetOpenAPICache,
  getCachedOpenAPISpec,
  validateExamplesAtBoot,
  createOpenAPIRouter,
} from '../openapi-config.js';
import { openapiRoute } from './openapi.js';

describe('Phase 16 plan 16-3: getCachedOpenAPISpec (D-13 boot-cache)', () => {
  beforeEach(() => {
    _resetOpenAPICache();
  });

  it('builds the document on first call and caches it byte-stably', () => {
    const app = createOpenAPIRouter();
    const a = getCachedOpenAPISpec(app);
    const b = getCachedOpenAPISpec(app);

    // Same object reference — cache hit.
    expect(a).toBe(b);
    // Serialized form is byte-identical.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('returns a valid OpenAPI 3.1 document with the v1 server URL', () => {
    const app = createOpenAPIRouter();
    const spec = getCachedOpenAPISpec(app) as {
      openapi: string;
      info: { title: string; version: string; description: string };
      servers: Array<{ url: string }>;
    };

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Spatula API');
    expect(spec.info.description).toContain('compat-policy');
    expect(spec.servers).toEqual([{ url: '/api/v1' }]);
  });

  it('_resetOpenAPICache forces a rebuild on the next call (pick up new routes)', () => {
    const appA = createOpenAPIRouter();
    const a = getCachedOpenAPISpec(appA);

    _resetOpenAPICache();

    // Different app instance with an extra route to verify the cache is
    // truly rebuilt (not just returning the old one).
    const appB = createOpenAPIRouter();
    appB.openapi(
      createRoute({
        method: 'get',
        path: '/probe',
        responses: {
          200: {
            description: 'probe',
            content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
          },
        },
      }),
      (c) => c.json({ ok: true }, 200),
    );
    const b = getCachedOpenAPISpec(appB);

    expect(a).not.toBe(b);
    expect(Object.keys((b as { paths: Record<string, unknown> }).paths)).toContain('/probe');
  });
});

describe('Phase 16 plan 16-3: GET /api/v1/openapi.json route', () => {
  beforeEach(() => {
    _resetOpenAPICache();
  });

  it('returns 200 with openapi:3.1.0 and non-empty paths', async () => {
    const rootApp = createOpenAPIRouter();
    rootApp.openapi(
      createRoute({
        method: 'get',
        path: '/hello',
        responses: {
          200: {
            description: 'hello',
            content: { 'application/json': { schema: z.object({ msg: z.string() }) } },
          },
        },
      }),
      (c) => c.json({ msg: 'hi' }, 200),
    );
    rootApp.route('/api/v1', openapiRoute(rootApp));

    const res = await rootApp.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });

  it('two sequential GETs return byte-identical bodies (cache works)', async () => {
    const rootApp = createOpenAPIRouter();
    rootApp.openapi(
      createRoute({
        method: 'get',
        path: '/hello',
        responses: {
          200: {
            description: 'hello',
            content: { 'application/json': { schema: z.object({ msg: z.string() }) } },
          },
        },
      }),
      (c) => c.json({ msg: 'hi' }, 200),
    );
    rootApp.route('/api/v1', openapiRoute(rootApp));

    const a = await (await rootApp.request('/api/v1/openapi.json')).text();
    const b = await (await rootApp.request('/api/v1/openapi.json')).text();

    expect(a).toBe(b);
  });
});

describe('Phase 16 plan 16-3: validateExamplesAtBoot (D-16)', () => {
  it('returns no errors when every example matches its schema', () => {
    const spec = {
      paths: {
        '/foo': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { count: { type: 'number' } },
                      required: ['count'],
                    },
                    example: { count: 42 },
                  },
                },
              },
            },
          },
        },
      },
    };
    const { errors } = validateExamplesAtBoot(spec);
    expect(errors).toEqual([]);
  });

  it('detects a deliberately off-schema example', () => {
    const spec = {
      paths: {
        '/bad': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { count: { type: 'number' } },
                      required: ['count'],
                    },
                    // String "forty-two" violates `type: number`.
                    example: { count: 'forty-two' },
                  },
                },
              },
            },
          },
        },
      },
    };
    const { errors } = validateExamplesAtBoot(spec);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/GET \/bad 200/);
  });

  it('supports both inline `example` and named `examples` blocks', () => {
    const spec = {
      paths: {
        '/named': {
          post: {
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                    examples: {
                      basic: { value: { id: 'abc-123' } },
                      bad: { value: { id: 999 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const { errors } = validateExamplesAtBoot(spec);
    // Only the "bad" example violates (id should be string).
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/POST \/named 201 example "bad"/);
  });

  it('skips responses without application/json content silently', () => {
    const spec = {
      paths: {
        '/binary': {
          get: {
            responses: {
              '200': {
                content: { 'application/octet-stream': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    };
    const { errors } = validateExamplesAtBoot(spec);
    expect(errors).toEqual([]);
  });

  it('handles spec.paths missing entirely (empty paths object)', () => {
    expect(() => validateExamplesAtBoot({ paths: {} })).not.toThrow();
    expect(() => validateExamplesAtBoot({})).not.toThrow();
  });
});

describe('Phase 16 plan 16-3: dev/test boot validator integration', () => {
  it('logs but does not throw when there are zero examples in the spec', () => {
    const spec = getCachedOpenAPISpec(createOpenAPIRouter());
    const { errors } = validateExamplesAtBoot(spec);
    // A bare OpenAPIRouter has no paths and no examples — validator is happy.
    expect(errors).toEqual([]);
    // Reset cache for any other test relying on a fresh build.
    _resetOpenAPICache();
  });

  it('does not pollute stderr when called with a valid spec', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    validateExamplesAtBoot({ paths: {} });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
