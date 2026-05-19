---
phase: 16-api-contract-sdk-packages
plan: 3
type: execute
wave: 3
depends_on:
  - 16-2
files_modified:
  - apps/api/src/openapi-config.ts
  - apps/api/src/routes/openapi.ts
  - apps/api/src/routes/openapi.test.ts
  - apps/api/src/routes/well-known.ts
  - apps/api/src/routes/well-known.test.ts
  - apps/api/src/app.ts
  - packages/client/src/version-probe.ts
  - packages/client/src/client.ts
  - packages/client/tests/unit/version-probe.test.ts
  - packages/client/package.json
  - docs/compat-policy.md
autonomous: true
requirements:
  - API-05
  - API-06
  - API-14

must_haves:
  truths:
    - "GET /api/v1/openapi.json returns a valid OpenAPI 3.1 document built ONCE at boot and cached (boot-cache pattern per D-13)"
    - "GET /.well-known/spatula-version returns { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors[] } }"
    - "Boot-time example validation (per D-16) runs in NODE_ENV !== 'production' — fails fast on off-schema OpenAPI examples"
    - "SpatulaClient lazily probes /.well-known/spatula-version on FIRST request (zero constructor I/O); caches result; throws SpatulaVersionMismatchError on major mismatch"
    - "docs/compat-policy.md documents the SDK ↔ server ↔ core-types matrix per spec §3.2.5"
  artifacts:
    - path: "apps/api/src/openapi-config.ts"
      provides: "Adds module-level cachedSpec + getCachedOpenAPISpec() boot-cache helper + dev-mode boot example validator"
      contains: "cachedSpec"
    - path: "apps/api/src/routes/openapi.ts"
      provides: "GET /api/v1/openapi.json handler serving the cached document"
      contains: "openapi.json"
    - path: "apps/api/src/routes/well-known.ts"
      provides: "GET /.well-known/spatula-version handler returning the version + git-sha + support-matrix payload"
      contains: "spatula-version"
    - path: "packages/client/src/version-probe.ts"
      provides: "Lazy one-shot version probe class with probePromise caching + reset on error"
      contains: "SpatulaVersionMismatchError"
    - path: "docs/compat-policy.md"
      provides: "SDK ↔ server ↔ core-types compat matrix; major-compat-within-major rule; mismatch error classes; 12-month support window"
      contains: "compat matrix"
  key_links:
    - from: "apps/api/src/routes/openapi.ts"
      to: "apps/api/src/openapi-config.ts"
      via: "Imports getCachedOpenAPISpec and serves its return value as application/json"
      pattern: "getCachedOpenAPISpec"
    - from: "apps/api/src/app.ts"
      to: "apps/api/src/routes/openapi.ts"
      via: "Mounts the openapi route + well-known route AFTER all other routes register"
      pattern: "app.route"
    - from: "packages/client/src/client.ts"
      to: "packages/client/src/version-probe.ts"
      via: "SpatulaClient.request() awaits probe.ensure() before fetching the actual request"
      pattern: "probe.ensure"
    - from: "packages/client/src/version-probe.ts"
      to: "/.well-known/spatula-version"
      via: "fetch from configured baseUrl + path"
      pattern: "/.well-known/spatula-version"
---

<objective>
Land the runtime-served OpenAPI document (GET /api/v1/openapi.json boot-cached via @hono/zod-openapi.getOpenAPI31Document()), the version-probe endpoint (GET /.well-known/spatula-version), and the lazy version-probe in @spatula/client that throws SpatulaVersionMismatchError on major-version mismatch. Commit docs/compat-policy.md per spec §3.2.5.

Purpose: These are the wire-format anchors that let a downstream consumer (browser web UI, third-party tool) verify the contract version at runtime BEFORE making real requests. The boot-cache pattern (D-13) ensures the OpenAPI document is byte-identical across requests, enabling downstream CDN caching. The lazy probe (D-12) keeps SpatulaClient SSR-safe (no constructor I/O).

Output:
- apps/api/src/routes/openapi.ts + well-known.ts + their tests
- apps/api/src/openapi-config.ts extended with getCachedOpenAPISpec() + dev-mode example validator
- packages/client/src/version-probe.ts + wired into SpatulaClient.request()
- docs/compat-policy.md committed
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md
@.planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md
@.planning/phases/16-api-contract-sdk-packages/16-VALIDATION.md
@.planning/phases/16-api-contract-sdk-packages/16-1-SUMMARY.md
@.planning/phases/16-api-contract-sdk-packages/16-2-SUMMARY.md
@docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md
@docs/private-contract.md

<interfaces>
From apps/api/src/openapi-config.ts (current; plan 16-1 already updated defaultHook; this plan adds getCachedOpenAPISpec):
```
export function createOpenAPIRouter(): OpenAPIHono<AppEnv> { /* unchanged */ }
```

From @hono/zod-openapi README (verified in research):
```
const doc = app.getOpenAPI31Document(
  { openapi: '3.1.0', info: { title: 'Spatula API', version: '1.0.0' }, servers: [{ url: '/api/v1' }] },
  { unionPreferredType: 'oneOf' },
);
// Returns a plain serializable JS object.
```

From apps/api/src/app.ts (current — mounts every existing route subrouter via app.route(...)):
- This plan APPENDS two more mounts AFTER all existing routes register:
  - app.route('/api/v1', openapiRoute(app))  → serves /api/v1/openapi.json
  - app.route('/', wellKnownRoute())          → serves /.well-known/spatula-version (NOTE: NOT under /api/v1)

From packages/client/src/client.ts (plan 16-2 output — modified here):
- Constructor stores { baseUrl, apiKey, fetch? } — no I/O (D-12).
- request<T>(method, path, body?) already implemented (plan 16-2).
- THIS plan adds: private probe field + await this.probe.ensure() at the top of request().

Spec §3.2.5 compat matrix (relevant excerpt):
- SDK and server MUST share major version. Cross-major calls throw SpatulaVersionMismatchError.
- @spatula/core-types and @spatula/client MUST share major version (exact-peer-dep, enforced via release-please linked-versions).
- Server supports the previous SDK major for 12 months post-major-cut.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Boot-cache OpenAPI document + serve at GET /api/v1/openapi.json + dev-mode example validator</name>
  <files>
    apps/api/src/openapi-config.ts,
    apps/api/src/routes/openapi.ts,
    apps/api/src/routes/openapi.test.ts,
    apps/api/src/app.ts
  </files>
  <read_first>
    - apps/api/src/openapi-config.ts (current state — plan 16-1 updated defaultHook; this task adds the boot-cache helper alongside)
    - apps/api/src/app.ts (find existing route mounts — must see the pattern for app.route(...) before adding new ones)
    - apps/api/src/routes/health.ts (small example of an OpenAPIHono subrouter — pattern for openapi.ts + well-known.ts)
    - tests/carveout/fixtures/server.ts (Node-builtin http.Server adapter — copy for openapi.test.ts harness; Phase 15 precedent that avoids needing @hono/node-server at workspace root)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-13 (boot-cache) + § D-16 (dev-only example validator)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 1 (boot-cache pseudocode) + Pattern 2 (Ajv 2020 setup — REUSE for the boot validator) + § "Common Pitfalls" Pitfall #1 (Ajv 2020 import)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Anti-Patterns to Avoid" Per-request OpenAPI generation
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.1 (new endpoints)
  </read_first>
  <behavior>
    - apps/api/src/openapi-config.ts gains a module-level cachedSpec variable + getCachedOpenAPISpec(app) helper that calls app.getOpenAPI31Document(...) exactly once and freezes the resulting object.
    - Also exports a _resetOpenAPICache() helper for test isolation.
    - Adds validateExamplesAtBoot(spec) that uses Ajv2020 (NOT default Ajv — pitfall #1) + ajv-formats to walk every (path, method, response.status, content.application/json.examples) and compile-validate each example body against its schema. Returns { errors: string[] }.
    - apps/api/src/routes/openapi.ts mounts GET /openapi.json on an OpenAPIHono subrouter; handler returns getCachedOpenAPISpec(rootApp) via c.json.
    - apps/api/src/app.ts mounts openapiRoute(app) at /api/v1 AFTER all other routes register; in NODE_ENV !== 'production' also runs validateExamplesAtBoot and throws on failure.
    - openapi.test.ts: (a) GET /api/v1/openapi.json returns 200 with openapi: '3.1.0' and non-empty paths; (b) two sequential GETs yield byte-identical bodies (cache works); (c) _resetOpenAPICache between GETs lets the second pick up a freshly-built spec; (d) validateExamplesAtBoot detects a deliberately bad fixture example.
  </behavior>
  <action>
    Step 1: Add Ajv deps at the workspace root so both this plan and plan 16-4 can use the same instance:
    ```
    pnpm add -Dw ajv@^8.20.0 ajv-formats@^3.0.1
    ```

    Step 2: Update apps/api/src/openapi-config.ts. KEEP the existing createOpenAPIRouter() (used by every route file). APPEND:
    ```
    import { OpenAPIHono } from '@hono/zod-openapi';
    import Ajv2020 from 'ajv/dist/2020.js';
    import addFormats from 'ajv-formats';
    import type { AppEnv } from './types.js';

    let cachedSpec: object | null = null;

    export function getCachedOpenAPISpec(app: OpenAPIHono<AppEnv>): object {
      if (cachedSpec) return cachedSpec;
      cachedSpec = app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: {
          title: 'Spatula API',
          version: process.env.SPATULA_VERSION ?? '1.0.0',
          description: 'Public REST contract for Spatula. Frozen at v1; additive-only in 1.x. See docs/compat-policy.md.',
        },
        servers: [{ url: '/api/v1' }],
      });
      return cachedSpec;
    }

    export function _resetOpenAPICache(): void { cachedSpec = null; }

    export function validateExamplesAtBoot(spec: any): { errors: string[] } {
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      const errors: string[] = [];
      for (const [path, methods] of Object.entries(spec.paths ?? {})) {
        for (const [method, op] of Object.entries(methods as any)) {
          for (const [status, response] of Object.entries((op as any).responses ?? {})) {
            const json = (response as any).content?.['application/json'];
            if (!json?.schema) continue;
            const validate = ajv.compile(json.schema);
            // Support both inline `example` and named `examples: { name: { value } }`
            const examples = json.examples
              ? Object.entries(json.examples).map(([n, e]: any) => [n, e?.value ?? e])
              : json.example ? [['default', json.example]] : [];
            for (const [exName, exBody] of examples) {
              if (!validate(exBody)) {
                errors.push(`${method.toUpperCase()} ${path} ${status} example "${exName}": ${ajv.errorsText(validate.errors)}`);
              }
            }
          }
        }
      }
      return { errors };
    }
    ```

    Step 3: Create apps/api/src/routes/openapi.ts:
    ```
    import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
    import { getCachedOpenAPISpec } from '../openapi-config.js';
    import type { AppEnv } from '../types.js';

    export function openapiRoute(rootApp: OpenAPIHono<AppEnv>) {
      const app = new OpenAPIHono<AppEnv>();
      app.openapi(
        createRoute({
          method: 'get',
          path: '/openapi.json',
          tags: ['system'],
          summary: 'Live OpenAPI 3.1 spec for this server (boot-cached)',
          description: 'Single source-of-truth for the v1 REST contract. Byte-identical across requests in a process lifetime.',
          responses: {
            200: {
              description: 'OpenAPI 3.1 document',
              content: { 'application/json': { schema: z.record(z.unknown()) } },
            },
          },
        }),
        (c) => c.json(getCachedOpenAPISpec(rootApp) as any, 200),
      );
      return app;
    }
    ```

    Step 4: Update apps/api/src/app.ts. Read the existing file. AFTER the LAST app.route('/api/v1/...', ...) call, add:
    ```
    import { openapiRoute } from './routes/openapi.js';
    import { getCachedOpenAPISpec, validateExamplesAtBoot } from './openapi-config.js';
    // ... existing mounts ...
    app.route('/api/v1', openapiRoute(app));
    if (process.env.NODE_ENV !== 'production') {
      const { errors } = validateExamplesAtBoot(getCachedOpenAPISpec(app));
      if (errors.length) {
        console.error('OpenAPI example validation failed at boot:\n' + errors.join('\n'));
        throw new Error('OpenAPI example validation failed (dev/test only); see logs.');
      }
    }
    ```

    Step 5: Write apps/api/src/routes/openapi.test.ts using the tests/carveout/fixtures/server.ts adapter pattern. Assertions per <behavior>.

    Step 6: Run pnpm --filter @spatula/api test -- openapi.test.ts and confirm green.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/api test -- openapi.test.ts && grep -q "getCachedOpenAPISpec" apps/api/src/openapi-config.ts && grep -q "validateExamplesAtBoot" apps/api/src/openapi-config.ts && grep -q "ajv/dist/2020" apps/api/src/openapi-config.ts && grep -q "openapiRoute" apps/api/src/app.ts</automated>
  </verify>
  <acceptance_criteria>
    - apps/api/src/openapi-config.ts contains the string "cachedSpec" AND "getCachedOpenAPISpec" AND "validateExamplesAtBoot"
    - apps/api/src/openapi-config.ts imports Ajv2020 via `from 'ajv/dist/2020'` (Pitfall #1) — grep -q "from 'ajv/dist/2020" apps/api/src/openapi-config.ts succeeds
    - apps/api/src/routes/openapi.ts exists; declares a GET on path '/openapi.json'
    - apps/api/src/app.ts mounts openapiRoute(app) AFTER all other route mounts — verified by reading the file (last route mount before any non-route logic)
    - apps/api/src/app.ts gates validateExamplesAtBoot on `NODE_ENV !== 'production'` — grep -A 3 "validateExamplesAtBoot" apps/api/src/app.ts shows the env check
    - openapi.test.ts asserts byte-identical responses across two GETs (boot cache verification)
    - openapi.test.ts asserts validateExamplesAtBoot returns errors on a bad fixture
    - `pnpm --filter @spatula/api test -- openapi.test.ts` passes
    - Implements API-05 (live /openapi.json from same source-of-truth as build); addresses D-13 + D-16 + Pitfall #1.
  </acceptance_criteria>
  <done>
    GET /api/v1/openapi.json serves the cached spec; dev-mode boot validation fails fast on off-schema examples; cache is byte-stable across requests.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: GET /.well-known/spatula-version + handler returning version + git-sha + support-matrix</name>
  <files>
    apps/api/src/routes/well-known.ts,
    apps/api/src/routes/well-known.test.ts,
    apps/api/src/app.ts
  </files>
  <read_first>
    - apps/api/src/routes/openapi.ts (Task 1 output — pattern for an OpenAPIHono subrouter; copy structure)
    - apps/api/src/app.ts (Task 1 modified — see how openapiRoute was mounted; mirror for well-known)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Code Examples" /.well-known/spatula-version route (full source provided there)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Domain" In-scope API-06
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.1 (versioning endpoint)
  </read_first>
  <behavior>
    - apps/api/src/routes/well-known.ts mounts GET /.well-known/spatula-version (NOT under /api/v1 — it's a root-level sibling). Returns { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors: number[] } }.
    - Values come from process.env: SPATULA_VERSION (fallback '0.0.0-dev'), GIT_SHA (fallback 'unknown'), BUILD_AT (fallback new Date().toISOString()).
    - For v1.0: supportMatrix.minClientMajor = 1, deprecatedClientMajors = [].
    - Mounted in app.ts AFTER openapiRoute (preserves the "all route mounts before getOpenAPI31Document() is called via Task 1's dev-only validator" ordering).
    - well-known.test.ts: GET returns 200 + the four top-level keys present + supportMatrix.minClientMajor === 1.
  </behavior>
  <action>
    Step 1: Create apps/api/src/routes/well-known.ts (verbatim from 16-RESEARCH § "Code Examples", with the response shape locked):
    ```
    import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
    import type { AppEnv } from '../types.js';

    const versionResponse = z.object({
      version: z.string().openapi({ example: '1.0.0' }),
      gitSha: z.string().openapi({ example: 'a1b2c3d4' }),
      buildAt: z.string().datetime().openapi({ example: '2026-05-19T14:32:00.000Z' }),
      supportMatrix: z.object({
        minClientMajor: z.number().openapi({ example: 1 }),
        deprecatedClientMajors: z.array(z.number()).openapi({ example: [] }),
      }),
    }).openapi('SpatulaVersion');

    export function wellKnownRoute() {
      const app = new OpenAPIHono<AppEnv>();
      app.openapi(
        createRoute({
          method: 'get',
          path: '/.well-known/spatula-version',
          tags: ['system'],
          summary: 'Server version + compat support matrix',
          description: 'Probed by SDK clients to verify major-version compatibility before issuing real requests. See docs/compat-policy.md.',
          responses: {
            200: {
              description: 'Server version metadata',
              content: { 'application/json': { schema: versionResponse } },
            },
          },
        }),
        (c) => c.json({
          version: process.env.SPATULA_VERSION ?? '0.0.0-dev',
          gitSha: process.env.GIT_SHA ?? 'unknown',
          buildAt: process.env.BUILD_AT ?? new Date().toISOString(),
          supportMatrix: { minClientMajor: 1, deprecatedClientMajors: [] },
        }),
      );
      return app;
    }
    ```

    Step 2: Update apps/api/src/app.ts. AFTER `app.route('/api/v1', openapiRoute(app));` from Task 1, add:
    ```
    import { wellKnownRoute } from './routes/well-known.js';
    // ... existing ...
    app.route('/', wellKnownRoute());   // /.well-known/spatula-version is a sibling of /api/v1
    ```
    NOTE: ordering matters — well-known MUST be mounted BEFORE the dev-only validateExamplesAtBoot block, so its schema is in the cached spec.

    Step 3: Write apps/api/src/routes/well-known.test.ts. Same Node-builtin http.Server harness; GET /.well-known/spatula-version asserts:
    - status 200
    - response body has exactly four top-level keys: version, gitSha, buildAt, supportMatrix
    - supportMatrix.minClientMajor === 1
    - supportMatrix.deprecatedClientMajors is an array (length 0 for v1.0)

    Step 4: Run pnpm --filter @spatula/api test -- well-known and confirm green.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/api test -- well-known && grep -q "/.well-known/spatula-version" apps/api/src/routes/well-known.ts && grep -q "supportMatrix" apps/api/src/routes/well-known.ts && grep -q "wellKnownRoute" apps/api/src/app.ts</automated>
  </verify>
  <acceptance_criteria>
    - apps/api/src/routes/well-known.ts exists; declares GET on path '/.well-known/spatula-version'
    - The response schema contains EXACTLY four top-level keys: version, gitSha, buildAt, supportMatrix — verified by reading source
    - supportMatrix has TWO keys: minClientMajor, deprecatedClientMajors — verified by source read
    - apps/api/src/app.ts mounts wellKnownRoute() at root path `/` (NOT under /api/v1) — grep -A 1 "wellKnownRoute" apps/api/src/app.ts shows `app.route('/'`
    - The well-known mount is BEFORE the validateExamplesAtBoot block in app.ts so the well-known route's example is included in validation — verified by reading file ordering
    - well-known.test.ts asserts status 200 + 4 top-level keys + minClientMajor === 1
    - `pnpm --filter @spatula/api test -- well-known` passes
    - Implements API-06.
  </acceptance_criteria>
  <done>
    GET /.well-known/spatula-version live; payload shape locked at { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors[] } }; for v1.0 minClientMajor=1, deprecatedClientMajors=[].
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Lazy version probe in @spatula/client — first-request gated, throws SpatulaVersionMismatchError on major mismatch</name>
  <files>
    packages/client/src/version-probe.ts,
    packages/client/src/client.ts,
    packages/client/tests/unit/version-probe.test.ts,
    packages/client/package.json
  </files>
  <read_first>
    - packages/client/src/client.ts (plan 16-2 output — current SpatulaClient class shape; this task adds probe field + gates request())
    - packages/client/src/errors/base.ts (SpatulaVersionMismatchError already defined by plan 16-2)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-12 (lazy probe semantics)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 6 (probe algorithm) + § "Anti-Patterns to Avoid" Constructor I/O + Throwing synchronously from constructor
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.2.5 (compat matrix)
  </read_first>
  <behavior>
    - packages/client/src/version-probe.ts exports a VersionProbe class:
      ```
      export class VersionProbe {
        private probePromise: Promise<void> | null = null;
        constructor(private opts: { baseUrl: string; fetcher: typeof fetch; sdkMajor: number }) {}
        ensure(): Promise<void> {
          if (this.probePromise) return this.probePromise;
          this.probePromise = (async () => {
            const res = await this.opts.fetcher(`${this.opts.baseUrl}/.well-known/spatula-version`);
            if (!res.ok) {
              // Treat a missing /.well-known endpoint as a permissive "unknown server" — log but don't block.
              // The major-mismatch gate fires ONLY on a successful response that disagrees.
              return;
            }
            const body = await res.json() as { version: string };
            const serverMajor = parseInt(body.version.split('.')[0], 10);
            if (Number.isNaN(serverMajor)) return;
            if (serverMajor !== this.opts.sdkMajor) {
              throw new SpatulaVersionMismatchError({
                code: 'VERSION.MISMATCH',
                message: `SDK major v${this.opts.sdkMajor} cannot speak to server major v${serverMajor}. See docs/compat-policy.md.`,
                status: 426,
                requestId: 'sdk-version-probe',
                details: { sdkMajor: this.opts.sdkMajor, serverMajor, serverVersion: body.version },
              });
            }
          })().catch((err) => {
            // On error, RESET so the next request can retry. Re-throw for the caller.
            this.probePromise = null;
            throw err;
          });
          return this.probePromise;
        }
      }
      ```
    - SDK major version: read from packages/client/package.json `version` field at build time. Hardcode in client.ts via a constant `const SDK_MAJOR_VERSION = 0` for the 0.x.y series (Phase 16 publishes 0.x; bumps to 1 happen at v1.0 launch via release-please). Document: when release-please bumps to 1.0.0, manually update SDK_MAJOR_VERSION constant.
    - packages/client/src/client.ts MODIFICATIONS:
      - Constructor accepts new optional opts: `{ baseUrl, apiKey, fetch?, skipVersionProbe? }`. The `skipVersionProbe` is for tests + degraded networks; defaults to false.
      - Adds `private probe: VersionProbe` field initialized in constructor.
      - request() body becomes:
        ```
        async request<T>(method, path, body?) {
          if (!this.opts.skipVersionProbe) await this.probe.ensure();
          // ... existing fetch logic ...
        }
        ```
    - version-probe.test.ts assertions:
      - new SpatulaClient(...).probe.ensure() does NOT throw if server returns version 0.x (sdkMajor matches)
      - Returns SpatulaVersionMismatchError on server.version === '1.0.0' when sdkMajor === 0
      - Same client, two sequential request() calls: probe.ensure() fires ONLY ONCE (verify via spy on fetcher)
      - On probe error, next request retries (probePromise reset)
      - 404 from /.well-known is treated as "unknown server" — does NOT throw
      - Constructor with skipVersionProbe: true does NOT call fetcher at all on request()
  </behavior>
  <action>
    Step 1: Create packages/client/src/version-probe.ts per <behavior>.

    Step 2: Update packages/client/src/client.ts:
    ```
    import { VersionProbe } from './version-probe.js';
    import { SpatulaVersionMismatchError, SpatulaApiError } from './errors/base.js';
    import { decodeError } from './errors/generated.js';

    const SDK_MAJOR_VERSION = 0;   // Update when release-please bumps to 1.0.0

    export interface SpatulaClientOptions {
      baseUrl: string;
      apiKey?: string;
      fetch?: typeof fetch;
      skipVersionProbe?: boolean;
    }

    export class SpatulaClient {
      private probe: VersionProbe;
      readonly experimental: Record<string, never>;
      constructor(private opts: SpatulaClientOptions) {
        const fetcher = opts.fetch ?? globalThis.fetch;
        this.probe = new VersionProbe({ baseUrl: opts.baseUrl, fetcher, sdkMajor: SDK_MAJOR_VERSION });
        // ... existing experimental namespace wiring from plan 16-2 ...
      }
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (!this.opts.skipVersionProbe) await this.probe.ensure();
        const fetcher = this.opts.fetch ?? globalThis.fetch;
        const res = await fetcher(`${this.opts.baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
          const envelope = await res.json().catch(() => ({ error: { code: 'INTERNAL.ERROR', message: res.statusText, requestId: 'unknown' } }));
          throw decodeError(envelope.error, res.status);
        }
        return res.json() as Promise<T>;
      }
    }
    ```

    Step 3: Write packages/client/tests/unit/version-probe.test.ts. Use vi.fn() to mock fetcher. Six test cases per <behavior>.

    Step 4: Update packages/client/src/index.ts to also export VersionProbe (for advanced users who want to drive the probe manually):
    ```
    export { VersionProbe } from './version-probe.js';
    ```

    Step 5: Run pnpm --filter @spatula/client test -- version-probe and confirm green.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/client test -- version-probe && grep -q "class VersionProbe" packages/client/src/version-probe.ts && grep -q "probe.ensure" packages/client/src/client.ts && grep -q "SpatulaVersionMismatchError" packages/client/src/version-probe.ts && grep -q "skipVersionProbe" packages/client/src/client.ts</automated>
  </verify>
  <acceptance_criteria>
    - packages/client/src/version-probe.ts exports `class VersionProbe` — `grep -q "class VersionProbe" packages/client/src/version-probe.ts`
    - VersionProbe.ensure() caches the probePromise — verified by unit test asserting fetcher called exactly once across 2 ensure() calls
    - On probe error, probePromise is reset (next call retries) — verified by unit test
    - On server returning a different major version (sdkMajor=0, serverMajor=1), VersionProbe throws SpatulaVersionMismatchError instance — `grep -q "SpatulaVersionMismatchError" packages/client/src/version-probe.ts`
    - On 404 from /.well-known (server doesn't support it), VersionProbe does NOT throw — graceful degradation
    - SpatulaClient constructor does NO I/O — unit test asserts via fetcher spy: spy.calls.length === 0 immediately after `new SpatulaClient(...)`
    - request() awaits probe.ensure() BEFORE the actual fetch — unit test asserts via mock call order (probe fetch precedes API fetch)
    - skipVersionProbe: true makes request() bypass probe entirely — verified
    - `pnpm --filter @spatula/client test -- version-probe` passes
    - Implements D-12 (lazy probe); addresses Anti-Patterns Constructor I/O + Throwing synchronously.
  </acceptance_criteria>
  <done>
    Lazy version probe runs at first-request; caches result for client lifetime; throws SpatulaVersionMismatchError on major mismatch; graceful when server lacks endpoint. Constructor stays I/O-free (SSR-safe).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Write docs/compat-policy.md — SDK ↔ server ↔ core-types compatibility matrix per spec §3.2.5</name>
  <files>
    docs/compat-policy.md
  </files>
  <read_first>
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.2.5 (compat matrix — VERBATIM source for the doc)
    - docs/private-contract.md (Phase 15 sister doc — copy formatting + tone; this is the public counterpart)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Docs created during this phase" (compat-policy.md is listed here)
    - packages/client/src/version-probe.ts (Task 3 output — referenced by name in the doc)
    - packages/client/src/errors/base.ts (SpatulaVersionMismatchError + FeatureUnavailableError — both named in the doc)
  </read_first>
  <behavior>
    - docs/compat-policy.md ships at least 5 sections:
      1. Purpose (one paragraph)
      2. Compat matrix table (server major ↔ SDK major ↔ core-types major)
      3. Major-compat-within-major rule + 12-month support window for previous SDK major
      4. Mismatch error classes (SpatulaVersionMismatchError, FeatureUnavailableError) + when each fires
      5. Probe behavior (lazy at first request; cached; can be skipped via skipVersionProbe for offline / mocked scenarios)
    - Doc contains the literal phrase "compat matrix" (validation script greps for it).
    - Cross-links to docs/api-errors.md (plan 16-2 ships the enum) and docs/deprecation-policy.md (plan 16-4 ships).
  </behavior>
  <action>
    Step 1: Write docs/compat-policy.md:
    ```
    # Spatula compatibility policy

    > **Authoritative source for SDK ↔ server ↔ core-types version compatibility.**
    > Cross-reference: `docs/api-errors.md` (error code enum), `docs/deprecation-policy.md` (experimental tag rules), `docs/private-contract.md` (internal-package compat carve-out for `spatula-saas`).

    ## Compat matrix

    | Component             | Compat rule                                                                                              |
    |-----------------------|----------------------------------------------------------------------------------------------------------|
    | `@spatula/core-types` | Frozen at v1; additive-only in 1.x. Removing or renaming an export is a major break.                     |
    | `@spatula/client`     | Exact-peer-dep on `@spatula/core-types` major (lockstep via release-please `linked-versions`).           |
    | `@spatula/api` (server) | REST contract frozen at v1. Server supports the previous SDK major for **12 months** post-major-cut.    |
    | `@spatula/cli`        | Independent semver. Bundles `@spatula/client` at the matching major.                                     |
    | `@spatula/core` / `db` / `queue` / `shared` | **No TS-API compat guarantee** (per `docs/private-contract.md`). Subject to silent breaking changes between minor versions. |

    ## Major-compat-within-major

    - **Servers and SDKs MUST share major version** for normal operation.
    - During a major bump (e.g., v1 → v2):
      - The OLD major server continues running for at least 12 months after v2.0 GA.
      - The NEW major SDK MUST refuse to talk to an old-major server (and vice versa).
    - **Verification:** the SDK lazily probes `GET /.well-known/spatula-version` on first request. On mismatch, throws `SpatulaVersionMismatchError` BEFORE the user's actual request fires. See `packages/client/src/version-probe.ts`.

    ## Mismatch error classes

    - **`SpatulaVersionMismatchError`** — server major ≠ SDK major. Thrown by the lazy probe on first `request()`.
    - **`FeatureUnavailableError`** — SDK calls an endpoint that the connected server doesn't support (e.g., SDK v1.5 calling a v1.5-introduced endpoint on a v1.4 server). Servers respond with `426` + `code: 'VERSION.MISMATCH'`; SDK decodes to this class.

    ## Probe behavior

    - **When**: Lazy — first `client.request()` call. Constructor performs zero I/O (SSR-safe).
    - **Caching**: One probe per client lifetime. Cached promise; concurrent requests await the same probe.
    - **Failure mode**: 404 from `/.well-known/spatula-version` is treated as "unknown server" — probe degrades gracefully, the request proceeds. This is intentional for talking to non-Spatula servers in tests.
    - **Opt-out**: Pass `skipVersionProbe: true` to the `SpatulaClient` constructor.

    ## 12-month support window

    After a major bump:
    - **Old-major server** continues running for ≥ 12 months. CI maintains a `release/v{N}` branch with critical-fix backports.
    - **Old-major SDK** continues installing from npm (we never unpublish). Old-major-on-new-major-server returns `426 + VERSION.MISMATCH`.
    - **`docs/api-errors.md` enum** for the old major remains the source of truth for that major's wire codes — additive-only changes only.

    ## Frozen wire shapes (v1)

    The following are FROZEN — changes are MAJOR breaks:
    - Error envelope: `{ error: { code, message, requestId, details? } }`
    - Error code namespace: `DOMAIN.CODE` (e.g., `JOB.NOT_FOUND`). Adding new codes is additive.
    - Cursor pagination envelope: `{ data, nextCursor, hasMore }`
    - Rate-limit header set: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
    - URL versioning: every public route under `/api/v1/`
    - Export format shapes: JSON, CSV, Parquet, SQLite, DuckDB (5 formats frozen)

    ## Experimental surfaces

    See `docs/deprecation-policy.md`. v1.0 ships ZERO experimental surfaces. First experimental surface (admin forensic-extractions endpoint) lands in Phase 18 and is accessed via `client.experimental.forensic.*`.

    ---

    *Last reviewed: 2026-MM-DD (Phase 16, plan 16-3).*
    ```

    Step 2: Commit the file. No tests needed (manual-only per 16-VALIDATION.md).
  </action>
  <verify>
    <automated>test -f docs/compat-policy.md && grep -q "compat matrix" docs/compat-policy.md && grep -q "SpatulaVersionMismatchError" docs/compat-policy.md && grep -q "12 months" docs/compat-policy.md && grep -q "skipVersionProbe" docs/compat-policy.md</automated>
  </verify>
  <acceptance_criteria>
    - docs/compat-policy.md exists — `test -f docs/compat-policy.md`
    - Contains the literal phrase "compat matrix" — `grep -q "compat matrix" docs/compat-policy.md` (matches 16-VALIDATION.md row API-14)
    - References SpatulaVersionMismatchError + FeatureUnavailableError (both error classes from plan 16-2's base.ts)
    - References the 12-month support window — `grep -q "12 months" docs/compat-policy.md`
    - References the lazy probe + skipVersionProbe opt-out — `grep -q "skipVersionProbe" docs/compat-policy.md`
    - Cross-links to docs/api-errors.md AND docs/deprecation-policy.md AND docs/private-contract.md — `grep -E "api-errors|deprecation-policy|private-contract" docs/compat-policy.md` returns ≥ 3 matches
    - Implements API-14.
  </acceptance_criteria>
  <done>
    docs/compat-policy.md committed; contains the full compat matrix per spec §3.2.5; cross-linked to sibling docs; covered by grep-based validation.
  </done>
</task>

</tasks>

<verification>
1. `pnpm --filter @spatula/api test -- openapi.test.ts well-known.test.ts` — both green.
2. `pnpm --filter @spatula/client test -- version-probe` — green.
3. `pnpm --filter @spatula/api build && pnpm --filter @spatula/api dev` (or local boot) → `curl http://localhost:3000/api/v1/openapi.json | jq '.openapi'` returns `"3.1.0"`.
4. `curl http://localhost:3000/.well-known/spatula-version | jq '.supportMatrix.minClientMajor'` returns `1`.
5. Two sequential `curl /api/v1/openapi.json` calls produce identical SHA-256 (`curl -s ... | shasum`) — boot cache works.
6. `test -f docs/compat-policy.md && grep -q "compat matrix" docs/compat-policy.md` succeeds.
</verification>

<success_criteria>
- API-05: `GET /api/v1/openapi.json` serves the boot-cached OpenAPI 3.1 document from the live `OpenAPIHono` registry; byte-identical across requests. Verified by openapi.test.ts.
- API-06: `GET /.well-known/spatula-version` returns the four-key payload with supportMatrix. Verified by well-known.test.ts.
- API-14: `docs/compat-policy.md` exists with the full compat matrix per spec §3.2.5. Verified by grep + manual read.
- Lazy version probe (D-12) wired into `SpatulaClient.request()`; constructor stays I/O-free; on major mismatch throws `SpatulaVersionMismatchError`. Verified by version-probe.test.ts.
- Dev-mode boot example validator (D-16) runs in `NODE_ENV !== 'production'` and fails fast on off-schema examples. Verified by openapi.test.ts.
- Ajv2020 import (Pitfall #1) — used everywhere ajv is used in this plan. Verified by grep gate.
</success_criteria>

<output>
After completion, create `.planning/phases/16-api-contract-sdk-packages/16-3-SUMMARY.md` recording:
- `/api/v1/openapi.json` response size (KB) and number of paths in the cached document
- `/.well-known/spatula-version` response payload sample
- Number of OpenAPI examples validated at boot (0 = none had examples; >0 = healthy coverage)
- Any boot-time example validation failures encountered + how fixed (likely route handlers' OpenAPI `example` blocks need touch-ups now that ErrorCode enum changed)
- Version probe behavior on a degraded network (graceful fallback verified)
- Cross-link evidence: docs/compat-policy.md references the three sibling docs
- Note: contract tests (API-12) consume `/api/v1/openapi.json` in plan 16-4
</output>
