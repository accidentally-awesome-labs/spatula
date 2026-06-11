import { OpenAPIHono } from '@hono/zod-openapi';
import { ErrorCode } from '@spatula/shared';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AppEnv } from './types.js';

export function createOpenAPIRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
        return c.json(
          {
            error: {
              // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'VALIDATION_ERROR').
              code: ErrorCode.VALIDATION_SCHEMA,
              message: result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(', '),
              requestId,
              details: { issues: result.error.issues },
            },
          },
          400,
        );
      }
    },
  });
}

// ===========================================================================
// Phase 16 plan 16-3: boot-cached OpenAPI document (D-13) + dev-mode example
// validator (D-16). The document is built ONCE at server startup and served
// byte-identically across every /api/v1/openapi.json request. Per-request
// generation would burn CPU walking the Zod registry and would defeat any
// downstream CDN caching.
// ===========================================================================

let cachedSpec: object | null = null;

/**
 * Build (or return cached) OpenAPI 3.1 document from the live `OpenAPIHono`
 * registry. Call AFTER all routes register. Subsequent calls return the same
 * frozen object reference — the JSON serialization is byte-stable across
 * requests within a process lifetime.
 */
export function getCachedOpenAPISpec(app: OpenAPIHono<AppEnv>): object {
  if (cachedSpec) return cachedSpec;
  cachedSpec = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Spatula API',
      version: process.env.SPATULA_VERSION ?? '1.0.0',
      description:
        'Public REST contract for Spatula. Frozen at v1; additive-only in 1.x. See docs/compat-policy.md.',
    },
    servers: [{ url: '/api/v1' }],
  });
  return cachedSpec;
}

/**
 * Test-only helper: reset the module-level cache so a subsequent
 * `getCachedOpenAPISpec(app)` call rebuilds the document. Used by
 * `openapi.test.ts` to assert cache-busting semantics. NOT exposed at runtime.
 */
export function _resetOpenAPICache(): void {
  cachedSpec = null;
}

/**
 * Walk every (path, method, response.status, content.application/json.examples)
 * tuple in the OpenAPI tree and compile-validate each example body against its
 * schema using Ajv's draft-2020-12 build (OpenAPI 3.1 dialect — Pitfall #1).
 *
 * Returns the list of human-readable error strings. Empty list = all examples
 * conform. Used by app.ts during boot in `NODE_ENV !== 'production'` to fail
 * fast on off-schema OpenAPI examples.
 */
export function validateExamplesAtBoot(spec: any): { errors: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ajv: any = (Ajv2020 as any).default ?? Ajv2020;
  const ajv = new Ajv({ strict: false, allErrors: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addFmts: any = (addFormats as any).default ?? addFormats;
  addFmts(ajv);

  // Register every component schema with an absolute `$id` so per-response
  // `$ref: "#/components/schemas/X"` references resolve when each response
  // schema is compiled in isolation. We rewrite the local pointer at the root
  // of the spec into a top-level schema map Ajv can resolve.
  const components =
    (spec as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
  for (const [name, componentSchema] of Object.entries(components)) {
    try {
      ajv.addSchema(componentSchema, `#/components/schemas/${name}`);
    } catch {
      // If a single component fails to register (e.g., duplicate name across
      // re-registrations in tests), keep going — per-response compile will
      // surface a clearer error below.
    }
  }

  const errors: string[] = [];
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const responses = (op as { responses?: Record<string, unknown> }).responses ?? {};
      for (const [status, response] of Object.entries(responses)) {
        const json = (response as { content?: Record<string, unknown> }).content?.[
          'application/json'
        ] as
          | { schema?: unknown; examples?: Record<string, unknown>; example?: unknown }
          | undefined;
        if (!json?.schema) continue;

        let validate: (data: unknown) => boolean;
        try {
          validate = ajv.compile(json.schema);
        } catch (err) {
          errors.push(
            `${method.toUpperCase()} ${path} ${status}: schema compile error: ${(err as Error).message}`,
          );
          continue;
        }

        // Support both inline `example` and named `examples: { name: { value } }`
        const examples: Array<[string, unknown]> = json.examples
          ? Object.entries(json.examples).map(([name, ex]) => [
              name,
              (ex as { value?: unknown })?.value ?? ex,
            ])
          : json.example !== undefined
            ? [['default', json.example]]
            : [];

        for (const [exName, exBody] of examples) {
          if (!validate(exBody)) {
            errors.push(
              `${method.toUpperCase()} ${path} ${status} example "${exName}": ${ajv.errorsText(
                (validate as { errors?: unknown[] }).errors,
              )}`,
            );
          }
        }
      }
    }
  }
  return { errors };
}
