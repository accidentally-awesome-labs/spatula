---
phase: 16-api-contract-sdk-packages
plan: 4
type: execute
wave: 3
depends_on:
  - 16-3
files_modified:
  - tests/contract/vitest.config.ts
  - tests/contract/README.md
  - tests/contract/helpers/ajv-setup.ts
  - tests/contract/helpers/server-harness.ts
  - tests/contract/helpers/fixtures.ts
  - tests/contract/generated.test.ts
  - tests/contract/errors.test.ts
  - tests/contract/headers.test.ts
  - tests/contract/deprecation.test.ts
  - tests/contract/timestamps.test.ts
  - tests/contract/versioning.test.ts
  - tests/contract/experimental.test.ts
  - .github/workflows/ci.yml
  - package.json
  - docs/api-errors.md
  - docs/api-idempotency.md
  - docs/cookbook/webhooks.md
  - docs/deprecation-policy.md
  - docs/architecture.md
autonomous: true
requirements:
  - API-07
  - API-08
  - API-09
  - API-10
  - API-11
  - API-12
  - API-13

must_haves:
  truths:
    - "tests/contract/ runs in CI on every PR; every (route, status, example) tuple from the served /openapi.json validates against its schema using Ajv2020"
    - "Every 4xx/5xx response across the API conforms to the error envelope (gate via tests/contract/errors.test.ts)"
    - "Every successful auth'd response carries the four rate-limit headers (gate via tests/contract/headers.test.ts)"
    - "Offset-paginated routes carry Deprecation + Sunset + Link headers; cursor routes don't (gate via tests/contract/deprecation.test.ts)"
    - "All timestamps in API responses parse as ISO 8601 UTC (gate via tests/contract/timestamps.test.ts)"
    - "Every public route path begins with /api/v1/ (gate via tests/contract/versioning.test.ts)"
    - "docs/api-errors.md, docs/api-idempotency.md, docs/cookbook/webhooks.md, docs/deprecation-policy.md exist and grep-validate against their per-REQ assertions"
    - "docs/architecture.md § 'Export format stability' lists 5 frozen formats"
  artifacts:
    - path: "tests/contract/vitest.config.ts"
      provides: "Vitest config for tests/contract/ — copies tests/private-contract/vitest.config.ts shape"
      contains: "contract"
    - path: "tests/contract/helpers/ajv-setup.ts"
      provides: "Single Ajv2020 instance shared across the suite (Pitfall #1 — uses 'ajv/dist/2020' import)"
      contains: "from 'ajv/dist/2020"
    - path: "tests/contract/helpers/server-harness.ts"
      provides: "Boots API + captures port; copies tests/carveout/fixtures/server.ts pattern (Node-builtin http.Server adapter)"
      contains: "http.Server"
    - path: "tests/contract/generated.test.ts"
      provides: "Matrix driver iterating served /openapi.json via describe.each + it.each"
      contains: "describe.each"
    - path: "tests/contract/errors.test.ts"
      provides: "Error envelope conformance gate — asserts every 4xx/5xx response matches { code, message, requestId, details? }"
      contains: "DOMAIN.CODE"
    - path: "tests/contract/headers.test.ts"
      provides: "Rate-limit header set gate"
      contains: "X-RateLimit-Reset"
    - path: "tests/contract/deprecation.test.ts"
      provides: "Sunset/Deprecation headers on offset routes ONLY"
      contains: "Sunset"
    - path: "tests/contract/timestamps.test.ts"
      provides: "ISO 8601 UTC parser sweep across response bodies"
      contains: "Z"
    - path: "tests/contract/versioning.test.ts"
      provides: "Every OpenAPI path begins with /api/v1/"
      contains: "/api/v1/"
    - path: "docs/api-errors.md"
      provides: "Frozen error-code enum reference; all DOMAIN.CODE values with HTTP status + typical conditions"
      contains: "DOMAIN.CODE"
    - path: "docs/api-idempotency.md"
      provides: "Worked Idempotency-Key examples; references Wave 3-4 existing implementation"
      contains: "Idempotency-Key"
    - path: "docs/cookbook/webhooks.md"
      provides: "HMAC-SHA256 verification example + retry schedule (1m, 5m, 30m, 2h, 8h → DLQ) + dedup pattern"
      contains: "HMAC-SHA256"
    - path: "docs/deprecation-policy.md"
      provides: "Experimental-tag policy (6-month max lifetime, graduate-or-remove, client.experimental.* namespace contract)"
      contains: "experimental"
    - path: "docs/architecture.md"
      provides: "New § 'Export format stability' lists the 5 frozen v1 export formats"
      contains: "5 formats frozen"
    - path: ".github/workflows/ci.yml"
      provides: "Adds `pnpm test:contract` to PR CI alongside existing test:carveout + test:private-contract jobs"
      contains: "test:contract"
  key_links:
    - from: "tests/contract/generated.test.ts"
      to: "tests/contract/helpers/server-harness.ts"
      via: "Boots the API server in suite-setup, captures port, fetches /api/v1/openapi.json from that port"
      pattern: "harness.start"
    - from: "tests/contract/generated.test.ts"
      to: "tests/contract/helpers/ajv-setup.ts"
      via: "Uses the shared Ajv2020 instance to compile and validate every (status, example) tuple"
      pattern: "createAjv"
    - from: ".github/workflows/ci.yml"
      to: "tests/contract/vitest.config.ts"
      via: "CI step `pnpm test:contract` invokes vitest with the contract config"
      pattern: "test:contract"
---

<objective>
Ship the contract test suite (tests/contract/) that consumes the live GET /api/v1/openapi.json from plan 16-3 and validates every (route, status, example) tuple via Ajv2020. This is the CI gate that catches drift between the OpenAPI spec and the actual response shape for the entire v1 lifetime. Bundle the doc deliverables (api-errors.md, api-idempotency.md, cookbook/webhooks.md, deprecation-policy.md, architecture.md export-format section) into the same plan because they share the test-suite cadence.

Purpose: Phase 16's hard gate. After this lands, every PR that breaks the v1 contract fails CI before merging. The doc deliverables batch here because they're zero-code and need to ship before plan 16-5's release infra can declare Phase 16 done.

Output:
- tests/contract/ full suite + vitest config + helpers (ajv-setup, server-harness, fixtures)
- 6 contract test files (generated matrix driver + 5 explicit per-REQ suites)
- 5 docs: api-errors.md, api-idempotency.md, cookbook/webhooks.md, deprecation-policy.md + architecture.md edit
- CI wiring: pnpm test:contract added to .github/workflows/ci.yml
- experimental-namespace.test.ts assertion that client.experimental Proxy throws on access (consumes plan 16-2 scaffolding)
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
@.planning/phases/16-api-contract-sdk-packages/16-3-SUMMARY.md
@docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md
@tests/carveout/vitest.config.ts
@tests/carveout/fixtures/server.ts
@tests/private-contract/vitest.config.ts

<interfaces>
From tests/carveout/fixtures/server.ts (Phase 15 — REUSE this Node-builtin http.Server adapter pattern; avoids adding @hono/node-server to workspace root):
```
// Boots the API with a randomly-assigned port; exposes { url, close }.
// Plan 16-4 server-harness.ts copies this verbatim then adds:
//   await fetch(`${url}/api/v1/openapi.json`).then(r => r.json())  → returns the served spec.
```

From plan 16-3 output (apps/api/src/routes/openapi.ts):
```
// GET /api/v1/openapi.json returns the boot-cached OpenAPI 3.1 document.
// tests/contract/ consumes this AT TEST-SUITE BOOT, then iterates the response.paths
// to generate one test case per (path, method, status, example) tuple via describe.each + it.each.
```

From packages/shared/src/error-codes.ts (plan 16-1, MOVED to @spatula/core-types by plan 16-2):
```
export const ErrorCode = { JOB_NOT_FOUND: 'JOB.NOT_FOUND', ... } as const;
// docs/api-errors.md generates a table from this.
```

From packages/queue/src/webhook-sender.ts (existing — pre-Phase-16 implementation):
- Already implements HMAC-SHA256 signing + retry schedule. docs/cookbook/webhooks.md DOCUMENTS this; no code changes.

From packages/core/src/exporters/ (existing — pre-Phase-16 implementation):
- 5 formats: JSON, CSV, Parquet, SQLite, DuckDB. docs/architecture.md § "Export format stability" enumerates these.

Spec §3.3.11 (verbatim relevant excerpt — experimental-tag policy):
- v1.0 ships ZERO experimental surfaces.
- Lifetime: 6 months max per surface; graduate (promote to stable) or remove.
- Removal emits Deprecation + Sunset headers (machinery deferred until first surface lands in Phase 18).
- Namespace: `client.experimental.*` (Phase 16 scaffolding from plan 16-2).
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold tests/contract/ — vitest config + Ajv2020 setup + server harness + fixtures</name>
  <files>
    tests/contract/vitest.config.ts,
    tests/contract/README.md,
    tests/contract/helpers/ajv-setup.ts,
    tests/contract/helpers/server-harness.ts,
    tests/contract/helpers/fixtures.ts,
    package.json
  </files>
  <read_first>
    - tests/carveout/vitest.config.ts (copy structure)
    - tests/private-contract/vitest.config.ts (alternate template — both work)
    - tests/carveout/fixtures/server.ts (Node-builtin http.Server adapter; REUSE pattern — copy into helpers/server-harness.ts)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 2 (matrix driver setup) + § "Common Pitfalls" Pitfall #1 (Ajv2020 import) + § "Open Questions" #4 (real infra)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-14, D-15 (contract test architecture)
    - package.json root (add `test:contract` script + ajv/ajv-formats devDeps if not already added by plan 16-3)
  </read_first>
  <behavior>
    - tests/contract/vitest.config.ts: copy tests/private-contract/vitest.config.ts. Configure: testEnvironment 'node', test include 'tests/contract/**/*.test.ts', testTimeout 30000 (server harness boot + matrix iteration).
    - tests/contract/helpers/ajv-setup.ts: exports `createAjv()` returning a configured Ajv2020 + ajv-formats instance. MUST use `import Ajv2020 from 'ajv/dist/2020.js'` (Pitfall #1; NOT default `from 'ajv'`).
      ```
      import Ajv2020 from 'ajv/dist/2020.js';
      import addFormats from 'ajv-formats';
      export function createAjv() {
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        addFormats(ajv);
        return ajv;
      }
      ```
    - tests/contract/helpers/server-harness.ts: copy tests/carveout/fixtures/server.ts adapter; export `startServer()` returning `{ url: string; close: () => Promise<void> }`. Boots the apps/api app with NODE_ENV='test', randomly-assigned port (use 0 + getsockname pattern), Postgres + Redis from existing docker-compose.
    - tests/contract/helpers/fixtures.ts: exports `seedFixtures(baseUrl): Promise<{tenantId, jobId, entityId, apiKey, ...}>` — uses the running server to create a tenant via admin API + a job + a fake entity. Returns IDs for path-param resolution in the matrix driver.
    - package.json root: add `"test:contract": "vitest run --config tests/contract/vitest.config.ts"` to scripts. Ensure ajv@^8.20.0 + ajv-formats@^3.0.1 in devDependencies (plan 16-3 may have added; idempotent).
    - tests/contract/README.md: documents the suite's purpose, how to run locally, what it gates.
  </behavior>
  <action>
    Step 1: `mkdir -p tests/contract/helpers`

    Step 2: Write tests/contract/vitest.config.ts. Copy tests/private-contract/vitest.config.ts then change `include` to `'tests/contract/**/*.test.ts'` + `testTimeout: 30_000`.

    Step 3: Write tests/contract/helpers/ajv-setup.ts per <behavior>.

    Step 4: Write tests/contract/helpers/server-harness.ts. Read tests/carveout/fixtures/server.ts to confirm exact shape:
    ```
    import { createServer, type Server } from 'node:http';
    import { createApp } from '@spatula/api';   // or the app factory function path
    import type { AddressInfo } from 'node:net';

    export interface ContractServer {
      url: string;
      close(): Promise<void>;
    }

    export async function startServer(): Promise<ContractServer> {
      const app = await createApp({ /* test deps stub or real */ });
      const server: Server = createServer(async (req, res) => {
        const result = await app.fetch(/* req->Request conversion per Hono adapter pattern */);
        // ... copy Phase 15 adapter body verbatim ...
      });
      await new Promise<void>(r => server.listen(0, () => r()));
      const { port } = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      };
    }
    ```
    (If apps/api has a `createApp` factory exposed for the carveout suite, reuse it. If not, plan 16-1 already exposes one via app.ts — confirm.)

    Step 5: Write tests/contract/helpers/fixtures.ts. Implement `seedFixtures(baseUrl)`:
    - POST /api/v1/admin/tenants with admin scope key (fixture admin token from .env.test) → returns tenantId.
    - POST /api/v1/jobs with that tenant → returns jobId.
    - INSERT a fake entity directly via @spatula/db (or POST whatever endpoint exists) → returns entityId.
    - Returns `{ tenantId, jobId, entityId, apiKey }`.

    Step 6: Update root package.json to add `"test:contract": "vitest run --config tests/contract/vitest.config.ts"`.

    Step 7: Write tests/contract/README.md:
    ```
    # tests/contract/

    Public REST contract test suite. Gates Phase 16's API-12 deliverable + every other contract requirement.

    ## What this proves

    - Every 4xx/5xx response from the OSS API matches the v1 error envelope (API-01).
    - Every OpenAPI example in the served `/api/v1/openapi.json` validates against its own schema (D-14, D-16).
    - Every auth'd success carries 3 rate-limit headers; 429 carries `Retry-After` (API-02).
    - Offset routes emit Deprecation + Sunset + Link; cursor routes don't (API-04).
    - All timestamps parse as ISO 8601 UTC (API-07).
    - Every public route is under `/api/v1/` (API-10).

    ## How it works

    Boots the API (Node-builtin http.Server adapter), fetches `/api/v1/openapi.json`, iterates every `(path, method, status, example)` tuple via `describe.each` + `it.each`, validates with Ajv2020 (NOT default Ajv — see Pitfall #1 in 16-RESEARCH.md).

    ## Run locally

    ```
    pnpm test:contract                  # full suite (~60–120s)
    pnpm test:contract -- errors        # single file
    ```

    Requires Postgres + Redis from `docker-compose.yml` running (same as `tests/carveout/`).
    ```

    Step 8: Run `pnpm install` if new deps added; smoke-test scaffolding with a placeholder test that just verifies the harness boots:
    ```
    // tests/contract/helpers/server-harness.smoke.test.ts (TEMP — delete after Task 2 lands real tests)
    import { startServer } from './server-harness.js';
    it('boots and responds to /api/v1/openapi.json', async () => {
      const s = await startServer();
      const res = await fetch(`${s.url}/api/v1/openapi.json`);
      expect(res.status).toBe(200);
      await s.close();
    });
    ```
    Run `pnpm test:contract` to confirm scaffolding works, then delete the smoke file.
  </action>
  <verify>
    <automated>test -f tests/contract/vitest.config.ts && test -f tests/contract/helpers/ajv-setup.ts && test -f tests/contract/helpers/server-harness.ts && test -f tests/contract/helpers/fixtures.ts && grep -q "from 'ajv/dist/2020" tests/contract/helpers/ajv-setup.ts && grep -q "http.Server\|node:http" tests/contract/helpers/server-harness.ts && grep -q "test:contract" package.json</automated>
  </verify>
  <acceptance_criteria>
    - tests/contract/vitest.config.ts exists and copies tests/private-contract/vitest.config.ts shape
    - tests/contract/helpers/ajv-setup.ts imports Ajv via `from 'ajv/dist/2020'` (Pitfall #1) — `grep -q "from 'ajv/dist/2020" tests/contract/helpers/ajv-setup.ts`
    - tests/contract/helpers/server-harness.ts uses Node-builtin http.Server (NOT @hono/node-server) — `grep -E "node:http|http\.Server" tests/contract/helpers/server-harness.ts`
    - tests/contract/helpers/fixtures.ts exports `seedFixtures` function
    - Root package.json `test:contract` script added — `grep -q '"test:contract"' package.json`
    - ajv@^8.20.0 + ajv-formats@^3.0.1 are in root devDependencies (plan 16-3 may have added; verify)
    - Smoke test passes locally: scaffolding boots server + fetches /api/v1/openapi.json
    - Implements Pitfall #1 + Open Question #4 (real infra) + lays foundation for Tasks 2 + 3.
  </acceptance_criteria>
  <done>
    Contract test scaffolding lives in tests/contract/; the suite boots a real server, fetches the live OpenAPI doc, and is ready for Task 2's matrix driver + Task 3's explicit per-REQ suites.
  </done>
</task>

<task type="auto">
  <name>Task 2: Generated matrix driver + per-REQ contract tests (errors, headers, deprecation, timestamps, versioning, experimental)</name>
  <files>
    tests/contract/generated.test.ts,
    tests/contract/errors.test.ts,
    tests/contract/headers.test.ts,
    tests/contract/deprecation.test.ts,
    tests/contract/timestamps.test.ts,
    tests/contract/versioning.test.ts,
    tests/contract/experimental.test.ts,
    .github/workflows/ci.yml
  </files>
  <read_first>
    - tests/contract/helpers/* (Task 1 output — server-harness.startServer, ajv-setup.createAjv, fixtures.seedFixtures)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 2 (full matrix driver pseudocode)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-14, D-15 (drift detection roundtrip)
    - apps/api/src/routes/openapi.ts (plan 16-3 — endpoint the matrix driver consumes)
    - apps/api/src/middleware/error-handler.ts (plan 16-1 — error envelope shape)
    - apps/api/src/middleware/rate-limit.ts (plan 16-1 — 4-header set)
    - apps/api/src/lib/deprecation-headers.ts (plan 16-1 — Sunset/Deprecation/Link)
    - .github/workflows/ci.yml (current — must add new test:contract job alongside existing test:carveout)
    - packages/client/src/experimental/index.ts (plan 16-2 — Proxy that throws on access)
  </read_first>
  <behavior>
    - tests/contract/generated.test.ts (the matrix driver):
      - `beforeAll`: start server via harness; seed fixtures; fetch /api/v1/openapi.json; cache spec in module scope.
      - `afterAll`: close server.
      - For each `(path, method)` in spec.paths × methods:
        - `describe.each` enumerates `(status, example)` tuples for that operation.
        - For each tuple:
          - If status is 2xx and `example` is present: hit the live route (with path params resolved from fixtures) and assert response body validates against schema.
          - If status is 4xx/5xx and `example` is present: assert the EXAMPLE itself validates against the operation's response schema (cheap — no live call).
          - Specifically for the 4xx/5xx envelope: assert example matches `{ error: { code: <DOMAIN.CODE shape>, message: string, requestId: string } }`.
    - tests/contract/errors.test.ts: Explicit per-REQ assertion for API-01. Boots server. Hits a known-404 path (e.g., `GET /api/v1/jobs/00000000-0000-0000-0000-000000000000`). Asserts response body = `{ error: { code: 'JOB.NOT_FOUND', message, requestId, details? } }`. Repeats for 401, 403, 422, 429.
    - tests/contract/headers.test.ts: API-02. Hits any authed GET endpoint; asserts response headers include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Hammers the same endpoint past the configured limit to provoke 429; asserts `Retry-After` present + envelope code === 'RATE_LIMIT.EXCEEDED'.
    - tests/contract/deprecation.test.ts: API-04. Hits an offset-paginated route with `?offset=0`; asserts `Deprecation`, `Sunset`, `Link` headers present. Hits same route with `?cursor=...`; asserts those three headers ABSENT.
    - tests/contract/timestamps.test.ts: API-07. Walks the cached spec for every response schema property named `createdAt`, `startedAt`, `completedAt`, `updatedAt`, `appliedAt`, `buildAt` etc.; hits an endpoint that returns each shape; asserts the value parses as a valid Date AND ends with `Z` (or `+00:00` UTC indicator).
    - tests/contract/versioning.test.ts: API-10. Walks the cached spec; asserts every key in `spec.paths` either starts with `/api/v1/` OR is `/.well-known/spatula-version` (the only sibling root path).
    - tests/contract/experimental.test.ts: API-13 (test side; doc side is Task 3). Imports @spatula/client; instantiates a SpatulaClient with `skipVersionProbe: true`; asserts that `client.experimental.foo` throws with message containing `'zero experimental surfaces'`. Plus asserts `experimental` is enumerable (so users can `Object.keys`).
    - .github/workflows/ci.yml: Add a new job (or extend existing test matrix) that runs `pnpm test:contract` alongside the existing test:carveout + test:private-contract jobs. Same Postgres + Redis services. Same TS lint/typecheck preflight.
  </behavior>
  <action>
    Step 1: Write tests/contract/generated.test.ts. Sketch:
    ```
    import { describe, it, expect, beforeAll, afterAll } from 'vitest';
    import { startServer, type ContractServer } from './helpers/server-harness.js';
    import { createAjv } from './helpers/ajv-setup.js';
    import { seedFixtures } from './helpers/fixtures.js';

    let server: ContractServer;
    let spec: any;
    let fixtures: Awaited<ReturnType<typeof seedFixtures>>;
    const ajv = createAjv();

    beforeAll(async () => {
      server = await startServer();
      const res = await fetch(`${server.url}/api/v1/openapi.json`);
      spec = await res.json();
      fixtures = await seedFixtures(server.url);
    });
    afterAll(async () => { if (server) await server.close(); });

    const tuples: Array<{ path: string; method: string; status: string; example: any; schema: any }> = [];
    // Populate at module-eval time — but spec isn't ready until beforeAll. Use a runtime describe inside it.test pattern:

    it('matrix driver discovers tuples after server boot', async () => {
      // ... iterate spec.paths -> describe.each(...) — see below for full pattern using lazy tuples
    });

    // ALTERNATIVE (recommended): use a single dynamic describe.each that reads spec AFTER beforeAll
    // via a vitest test-context pattern. Implementation per Pattern 2 in 16-RESEARCH.md.
    ```
    NOTE: vitest's `describe.each` is evaluated synchronously at module load. To support spec-from-beforeAll, either:
    (a) pre-fetch spec OUTSIDE beforeAll (cold fetch at module load — start a temporary server just to grab spec, OR
    (b) generate one large `it()` per tuple inside a single `describe('OpenAPI matrix', () => { /* dynamic it() */ })`.
    Choose (b): inside the top-level `describe`, after beforeAll completes, use `it('...', async () => { for (const tuple of tuples) { ... } })` with iteration. OR use `test.for` / `vi.dynamic` if available.

    Practical pattern: keep one `it()` per response status group, iterating examples inside:
    ```
    describe('matrix conformance', () => {
      it('every 2xx response schema validates against handler output', async () => {
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods as any)) {
            const successResponses = Object.entries((op as any).responses).filter(([s]) => s.startsWith('2'));
            for (const [status, response] of successResponses) {
              const schema = (response as any).content?.['application/json']?.schema;
              if (!schema) continue;
              const url = resolvePath(server.url, path, fixtures);
              const res = await fetch(url, { method: method.toUpperCase(), headers: authHeaders(fixtures) });
              if (res.status === Number(status)) {
                const body = await res.json();
                const validate = ajv.compile(schema);
                if (!validate(body)) {
                  throw new Error(`${method.toUpperCase()} ${path} ${status}: ${ajv.errorsText(validate.errors)}`);
                }
              }
            }
          }
        }
      });

      it('every 4xx/5xx example in OpenAPI validates against its schema', async () => {
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods as any)) {
            const errorResponses = Object.entries((op as any).responses).filter(([s]) => Number(s) >= 400);
            for (const [status, response] of errorResponses) {
              const json = (response as any).content?.['application/json'];
              if (!json?.schema) continue;
              const examples = json.examples ? Object.values(json.examples).map((e: any) => e.value ?? e) : (json.example ? [json.example] : []);
              for (const ex of examples) {
                const validate = ajv.compile(json.schema);
                expect(validate(ex), `${method.toUpperCase()} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
              }
            }
          }
        }
      });
    });
    ```

    Step 2: Write tests/contract/errors.test.ts. Five sub-tests: 404 (JOB.NOT_FOUND), 401 (AUTH.MISSING_TOKEN), 403 (AUTH.INSUFFICIENT_SCOPE), 422 (VALIDATION.SCHEMA via bogus POST body), 429 (RATE_LIMIT.EXCEEDED via burst). Each asserts envelope shape via `expect(body.error.code).toMatch(/^[A-Z_]+\.[A-Z_]+$/)`.

    Step 3: Write tests/contract/headers.test.ts. Hit GET /api/v1/health (or any safe authed endpoint); assert response.headers contains the three success headers. Burst 350 requests (default limit 300/min) to provoke 429; assert Retry-After present + envelope code matches RATE_LIMIT.EXCEEDED.

    Step 4: Write tests/contract/deprecation.test.ts. Hit GET /api/v1/entities?offset=0&limit=10; assert response.headers.get('Deprecation') is truthy AND `Sunset` is truthy AND `Link` includes `successor-version`. Hit GET /api/v1/entities?cursor=<seeded-cursor>; assert all three headers ABSENT.

    Step 5: Write tests/contract/timestamps.test.ts. Walk spec; find every property with `format: 'date-time'`; for each, hit an endpoint that returns it; assert the returned value: (a) is a string, (b) `new Date(value)` is a valid Date, (c) ends with `Z` OR contains `+00:00`. Also check NO purely-numeric timestamp values in response bodies via a generic walk.

    Step 6: Write tests/contract/versioning.test.ts:
    ```
    it('every OpenAPI path is under /api/v1/ or /.well-known/', () => {
      for (const path of Object.keys(spec.paths)) {
        expect(path === '/.well-known/spatula-version' || path.startsWith('/api/v1/'), `Path '${path}' violates URL versioning`).toBe(true);
      }
    });
    ```

    Step 7: Write tests/contract/experimental.test.ts:
    ```
    import { SpatulaClient } from '@spatula/client';
    it('client.experimental throws when accessed (zero v1.0 surfaces)', () => {
      const client = new SpatulaClient({ baseUrl: server.url, skipVersionProbe: true });
      expect(() => (client as any).experimental.forensic).toThrow(/zero experimental surfaces/);
      expect(() => (client as any).experimental.anyOtherThing).toThrow(/zero experimental surfaces/);
    });
    ```

    Step 8: Update .github/workflows/ci.yml. Find the existing test job (probably `test`); ADD a new step or new job `test-contract`:
    ```yaml
    test-contract:
      name: Contract tests
      runs-on: ubuntu-latest
      services:
        postgres: { image: postgres:16, ... }   # copy existing test job services
        redis: { image: redis:7-alpine, ... }
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
          with: { version: 9.15.4 }
        - uses: actions/setup-node@v4
          with: { node-version: '22', cache: 'pnpm' }
        - run: pnpm install --frozen-lockfile
        - run: pnpm build
        - run: pnpm db:migrate
        - run: pnpm test:contract
    ```
    Mirror the existing test:carveout / test:private-contract job's env vars + setup steps. Add as a required check on main protection (gh CLI not needed; this is verifying the file change).

    Step 9: Run pnpm test:contract locally to confirm all six suites pass. Iterate on flaky 429 burst timing or fixture seeding as needed.
  </action>
  <verify>
    <automated>pnpm test:contract && grep -q "X-RateLimit-Reset" tests/contract/headers.test.ts && grep -q "Sunset" tests/contract/deprecation.test.ts && grep -q "DOMAIN.CODE\|[A-Z_]+\\\\.[A-Z_]+" tests/contract/errors.test.ts && grep -q "zero experimental surfaces" tests/contract/experimental.test.ts && grep -q "test:contract" .github/workflows/ci.yml && grep -q "/.well-known/spatula-version\|/api/v1/" tests/contract/versioning.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - tests/contract/generated.test.ts iterates spec.paths and validates examples — grep finds `Object.entries(spec.paths` AND `ajv.compile`
    - tests/contract/errors.test.ts asserts 5 distinct error codes (JOB.NOT_FOUND, AUTH.MISSING_TOKEN, AUTH.INSUFFICIENT_SCOPE, VALIDATION.SCHEMA, RATE_LIMIT.EXCEEDED) — `grep -c "DOMAIN\|JOB\\.\\|AUTH\\.\\|VALIDATION\\.\\|RATE_LIMIT\\." tests/contract/errors.test.ts` ≥ 5
    - tests/contract/headers.test.ts asserts all 4 rate-limit headers — grep finds `X-RateLimit-Limit` + `X-RateLimit-Remaining` + `X-RateLimit-Reset` + `Retry-After`
    - tests/contract/deprecation.test.ts asserts headers present on offset routes AND absent on cursor routes
    - tests/contract/timestamps.test.ts asserts Z suffix OR UTC offset on every date-time value
    - tests/contract/versioning.test.ts asserts every spec path under /api/v1/ OR /.well-known/
    - tests/contract/experimental.test.ts asserts client.experimental throws on access
    - .github/workflows/ci.yml contains a `test:contract` step — `grep -q "test:contract" .github/workflows/ci.yml`
    - `pnpm test:contract` passes locally (all 6 files green)
    - Implements API-12 (the suite) + per-REQ gates for API-01, API-02, API-04, API-07, API-10, API-13 (test side).
  </acceptance_criteria>
  <done>
    Six contract test files green; CI runs them on every PR; gate covers error envelope, headers, deprecation, timestamps, versioning, and experimental-namespace scaffolding.
  </done>
</task>

<task type="auto">
  <name>Task 3: Ship docs/api-errors.md + docs/api-idempotency.md + docs/cookbook/webhooks.md + docs/deprecation-policy.md + docs/architecture.md export-format edit</name>
  <files>
    docs/api-errors.md,
    docs/api-idempotency.md,
    docs/cookbook/webhooks.md,
    docs/deprecation-policy.md,
    docs/architecture.md
  </files>
  <read_first>
    - packages/core-types/src/errors/codes.ts (plan 16-2 — source of truth for the ErrorCode enum that docs/api-errors.md references)
    - packages/queue/src/webhook-sender.ts (existing — webhook implementation; cookbook describes this code, doesn't change it)
    - apps/api/src/middleware/idempotency.ts (Wave 3-4 — already implemented; doc describes existing behavior)
    - packages/core/src/exporters/ (existing — 5 export formats; architecture.md edit enumerates these)
    - docs/compat-policy.md (plan 16-3 — sister doc; tone + cross-link patterns)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Docs created during this phase"
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Phase Requirements" rows for API-08, API-09, API-11, API-13
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.8 (webhooks) + § 3.3.10 (export formats) + § 3.3.11 (experimental tag)
  </read_first>
  <behavior>
    - docs/api-errors.md: full enum reference. Table with one row per ErrorCode: `| Code | HTTP status | Typical condition | details? schema |`. Generated by reading packages/core-types/src/errors/codes.ts at edit time; human-authored prose around it.
    - docs/api-idempotency.md: 3 worked examples of Idempotency-Key header use (POST /api/v1/jobs with same key → returns cached 201; same key with different body → 409 IDEMPOTENCY.KEY_CONFLICT; different key → fresh job). Curl + SDK snippets. References Wave 3-4 implementation in apps/api/src/middleware/idempotency.ts.
    - docs/cookbook/webhooks.md: HMAC-SHA256 verification example (Node + Python snippets), retry schedule table (1m, 5m, 30m, 2h, 8h → DLQ), dedup pattern (use `event.id` + idempotent processing). References packages/queue/src/webhook-sender.ts.
    - docs/deprecation-policy.md: experimental-tag policy. Sections: (1) v1.0 ships ZERO experimental surfaces (state of the world), (2) 6-month max lifetime per experimental surface, (3) graduate-or-remove rule (no permanent experimental status), (4) `client.experimental.*` namespace contract (scaffolding from plan 16-2), (5) Deprecation + Sunset header emission (machinery deferred to Phase 18 when first surface lands), (6) cross-link to docs/compat-policy.md.
    - docs/architecture.md: add a new section "Export format stability". Lists the 5 formats: JSON, CSV, Parquet, SQLite, DuckDB. States: "5 formats frozen at v1" (literal phrase — 16-VALIDATION.md greps for this).
  </behavior>
  <action>
    Step 1: Write docs/api-errors.md:
    ```
    # Spatula API errors

    > Frozen error-code enum + envelope reference. See `packages/core-types/src/errors/codes.ts` for the authoritative source.

    ## Envelope

    Every 4xx/5xx response from `/api/v1/*` matches:

    ```json
    {
      "error": {
        "code": "DOMAIN.CODE",
        "message": "Human-readable message",
        "requestId": "uuid",
        "details": { "...": "context-specific" }
      }
    }
    ```

    `code` follows `DOMAIN.CODE` (category-prefixed). The enum is FROZEN at v1; additive-only in 1.x.

    ## Enum reference

    | Code | HTTP | Typical condition | `details` shape |
    |------|------|-------------------|------------------|
    | JOB.NOT_FOUND | 404 | Path-resolved job ID not in current tenant | `{ jobId }` |
    | JOB.CONFLICT | 409 | State transition rejected (e.g., cancel a completed job) | `{ jobId, currentStatus }` |
    | JOB.INVALID_STATE | 409 | Operation requires a different job state | `{ jobId, currentStatus, requiredStatus }` |
    | EXTRACTION.QUOTA_EXCEEDED | 429 | Tenant quota exceeded for extractions | `{ quota, used, resetAt }` |
    | EXTRACTION.FAILED | 422 | LLM extraction rejected or off-schema after retry | `{ extractionId, reason }` |
    | SCHEMA.NOT_FOUND | 404 | Schema version not found for job | `{ schemaId }` |
    | SCHEMA.VERSION_CONFLICT | 409 | Schema evolution conflict | `{ jobId, existingVersion, attemptedVersion }` |
    | ENTITY.NOT_FOUND | 404 | Entity ID not in current tenant | `{ entityId }` |
    | EXPORT.NOT_FOUND | 404 | Export ID not found | `{ exportId }` |
    | EXPORT.FAILED | 422 | Export job failed during materialization | `{ exportId, reason }` |
    | AUTH.INVALID_TOKEN | 401 | Provided Bearer token is invalid or expired | `{ }` |
    | AUTH.MISSING_TOKEN | 401 | Request lacks Authorization header | `{ }` |
    | AUTH.INSUFFICIENT_SCOPE | 403 | Token authenticated but lacks required scope | `{ required, granted[] }` |
    | TENANT.NOT_FOUND | 404 | Tenant ID resolved from token does not exist | `{ tenantId }` |
    | RATE_LIMIT.EXCEEDED | 429 | Per-route rate limit hit | `{ limit, resetAt }` |
    | QUOTA.EXCEEDED | 429 | Per-tenant quota hit | `{ quota, used, resetAt }` |
    | VERSION.MISMATCH | 426 | SDK major ≠ server major | `{ sdkMajor, serverMajor }` |
    | VALIDATION.SCHEMA | 400 | Request body fails zod schema validation | `{ issues[] }` |
    | VALIDATION.PARAMS | 400 | Query/path params fail validation | `{ issues[] }` |
    | IDEMPOTENCY.KEY_CONFLICT | 409 | Same Idempotency-Key reused with different body | `{ idempotencyKey, originalRequestId }` |
    | WEBHOOK.SIGNATURE_INVALID | 401 | Webhook HMAC signature failed verification | `{ }` |
    | INTERNAL.ERROR | 500 | Generic server error | `{ }` |
    | INTERNAL.TIMEOUT | 504 | Upstream operation timed out | `{ }` |
    | INTERNAL.QUEUE | 503 | Background queue temporarily unavailable | `{ }` |
    | INTERNAL.NETWORK | 502 | Upstream service unreachable | `{ }` |

    ## Cross-references

    - `docs/compat-policy.md` — SDK ↔ server ↔ core-types compat matrix.
    - `docs/api-idempotency.md` — `Idempotency-Key` worked examples.
    - `docs/deprecation-policy.md` — experimental-tag policy.
    ```

    Step 2: Write docs/api-idempotency.md:
    ```
    # Idempotency keys

    > Documented in Phase 16; functionality implemented in Wave 3-4. See `apps/api/src/middleware/idempotency.ts`.

    ## Worked examples

    ### 1. Same key + same body → cached response

    ```bash
    curl -X POST https://api.spatula.dev/api/v1/jobs \
      -H "Authorization: Bearer $KEY" \
      -H "Idempotency-Key: 7f3a..." \
      -H "Content-Type: application/json" \
      -d '{"name":"crawl-1"}'
    # → 201 { "id": "abc...", ... }

    # Replay (within 24h TTL):
    curl -X POST ... -H "Idempotency-Key: 7f3a..." -d '{"name":"crawl-1"}'
    # → 201 { "id": "abc...", ... }     # SAME id; cached
    ```

    ### 2. Same key + different body → 409

    ```bash
    curl -X POST ... -H "Idempotency-Key: 7f3a..." -d '{"name":"different"}'
    # → 409 { "error": { "code": "IDEMPOTENCY.KEY_CONFLICT", ... } }
    ```

    ### 3. SDK usage

    ```typescript
    const job = await client.createJob({ name: 'crawl-1' }, { idempotencyKey: '7f3a...' });
    ```

    ## Scope

    Idempotency keys apply to POST, PATCH, DELETE on /api/v1/*. GET/HEAD are inherently idempotent.

    ## TTL + storage

    Keys stored 24 hours. Beyond TTL, the same key may produce a fresh request.

    ## Recommended key format

    UUIDv4. The server treats keys as opaque strings; uniqueness is the caller's responsibility.
    ```

    Step 3: Create directory + write docs/cookbook/webhooks.md (`mkdir -p docs/cookbook`):
    ```
    # Webhooks

    > HMAC-SHA256 signed delivery with retry. Implementation: `packages/queue/src/webhook-sender.ts`.

    ## Verification (Node)

    ```typescript
    import crypto from 'node:crypto';
    function verify(rawBody: string, signature: string, secret: string): boolean {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    }
    ```

    ## Verification (Python)

    ```python
    import hmac, hashlib
    def verify(raw_body: bytes, signature: str, secret: str) -> bool:
        expected = 'sha256=' + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    ```

    ## Retry schedule

    HMAC-SHA256 delivery retries on non-2xx:

    | Attempt | Delay | Total elapsed |
    |---------|-------|---------------|
    | 1 | — | 0 |
    | 2 | 1m | 1m |
    | 3 | 5m | 6m |
    | 4 | 30m | 36m |
    | 5 | 2h | 2h 36m |
    | 6 | 8h | 10h 36m |
    | — | DLQ | events.failed |

    After attempt 6 (cumulative ~10.5h), the event lands in the DLQ.

    ## Dedup pattern

    Each event carries `event.id` (UUIDv4). Receivers should:
    1. Reject duplicate `event.id` (within a reasonable window — e.g., 24h).
    2. Process events idempotently — same `event.id` processed twice MUST produce the same effect.

    ## Headers

    - `X-Spatula-Signature: sha256=<hex>` — HMAC of the raw body.
    - `X-Spatula-Event-Id: <uuid>` — unique per delivery.
    - `X-Spatula-Event-Type: <type>` — e.g., `job.completed`.
    ```

    Step 4: Write docs/deprecation-policy.md:
    ```
    # Spatula deprecation and experimental-tag policy

    > Authoritative source for how Spatula introduces, ages, and removes experimental and deprecated surfaces.

    ## v1.0 state

    Spatula v1.0 ships with **zero experimental surfaces**. The policy in this doc is in force from v1.0; the first experimental surface (admin forensic-extractions endpoint) lands in Phase 18.

    ## Experimental tag

    An "experimental" surface is an endpoint, SDK method, or response field tagged `x-spatula-experimental: true` in OpenAPI. Properties:

    - Accessed via the `client.experimental.*` namespace in `@spatula/client` (scaffolding lives in v1.0 — empty Proxy that throws on access until a real surface lands).
    - Lifetime: 6 months MAXIMUM. After 6 months, the surface MUST either:
      - **Graduate**: drop the `x-spatula-experimental` tag, become a stable v1 surface (additive — no major bump).
      - **Remove**: emit `Deprecation` + `Sunset` headers for one release cycle, then delete.
    - No "permanent experimental" surfaces. The tag is a temporary holding pen, not a feature category.

    ## Deprecation headers

    When a stable surface is being removed (across a major bump) or an experimental graduates with shape changes, the SERVER emits:

    - `Deprecation: <HTTP-date>` — date of deprecation announcement (RFC 8594).
    - `Sunset: <HTTP-date>` — date after which the surface returns 410 Gone.
    - `Link: </docs/compat-policy>; rel="successor-version"` — pointer to the replacement.

    See `apps/api/src/lib/deprecation-headers.ts` for the helper. Offset-paginated routes already emit these — see API-04.

    ## Cross-references

    - `docs/compat-policy.md` — full SDK ↔ server ↔ core-types compat matrix.
    - `docs/api-errors.md` — frozen error-code enum.
    - Spec §3.3.11 — original policy text.
    ```

    Step 5: Edit docs/architecture.md to add the "Export format stability" section. Find an appropriate place (probably under a top-level §"API surface" or §"Data model"). Append:
    ```
    ## Export format stability

    Spatula exports data in **5 formats frozen at v1**: JSON, CSV, Parquet, SQLite, DuckDB. Each format includes per-field provenance metadata (extracted | normalized | merged | resolved | inferred). The wire shape of each format is FROZEN — additive-only in 1.x. Removing or restructuring exported columns is a MAJOR break.

    | Format | Provenance shape | Use case |
    |--------|------------------|----------|
    | JSON | Per-record nested `_provenance` object | Programmatic consumption; SDK round-trips |
    | CSV | Per-field `<field>__source` sibling columns | Spreadsheet / quick inspection |
    | Parquet | Provenance struct column | Analytical queries; columnar warehouse |
    | SQLite | Sidecar `_provenance` table | Embeddable; offline analysis |
    | DuckDB | Same as SQLite + materialized provenance view | Analytical queries; SQL-native |

    See `packages/core/src/exporters/` for the implementations.
    ```
    NOTE: The literal phrase "5 formats frozen" is what 16-VALIDATION.md greps for.

    Step 6: Verify each file via the grep gates in <verify>.
  </action>
  <verify>
    <automated>test -f docs/api-errors.md && grep -q "JOB\\.NOT_FOUND\|DOMAIN.CODE" docs/api-errors.md && test -f docs/api-idempotency.md && grep -q "Idempotency-Key" docs/api-idempotency.md && test -f docs/cookbook/webhooks.md && grep -q "HMAC-SHA256" docs/cookbook/webhooks.md && test -f docs/deprecation-policy.md && grep -q "experimental" docs/deprecation-policy.md && grep -q "5 formats frozen" docs/architecture.md</automated>
  </verify>
  <acceptance_criteria>
    - docs/api-errors.md exists with a table containing at least 15 rows (DOMAIN.CODE entries) — `grep -c "^| [A-Z_]\\+\\." docs/api-errors.md` ≥ 15
    - docs/api-idempotency.md exists; contains the string "Idempotency-Key" + curl examples + SDK snippet
    - docs/cookbook/webhooks.md exists; contains "HMAC-SHA256" + the retry table with 1m, 5m, 30m, 2h, 8h timings — `grep -E "1m|5m|30m|2h|8h" docs/cookbook/webhooks.md` returns ≥ 5 lines
    - docs/deprecation-policy.md exists; contains "experimental" + "6 months" + "client.experimental"
    - docs/architecture.md contains "5 formats frozen" (literal — grep gate from 16-VALIDATION.md)
    - docs/architecture.md lists all 5 formats: JSON, CSV, Parquet, SQLite, DuckDB
    - Cross-links: api-errors.md AND deprecation-policy.md reference compat-policy.md; webhooks.md references packages/queue/src/webhook-sender.ts
    - Implements API-07 (timestamps — note: timestamp test gate is in Task 2, doc state is the architecture.md sentence in passing), API-08 (idempotency doc), API-09 (webhook cookbook), API-10 (versioning — covered in api-errors.md + compat-policy.md, test gate in Task 2), API-11 (export format stability), API-13 (deprecation policy doc).
  </acceptance_criteria>
  <done>
    Five docs committed; all grep gates pass; each doc has at least 1 cross-link to a sibling doc; existing implementations (idempotency, webhooks) documented WITHOUT code changes (deferred per CONTEXT.md).
  </done>
</task>

</tasks>

<verification>
1. `pnpm test:contract` — full contract suite green (6 test files).
2. `pnpm test:contract && pnpm test:carveout && pnpm test:private-contract && pnpm test` — full suite stack green.
3. Grep gates per 16-VALIDATION.md per-task verification map:
   - `test -f docs/api-idempotency.md && grep -q 'Idempotency-Key' docs/api-idempotency.md`
   - `test -f docs/cookbook/webhooks.md && grep -q 'HMAC-SHA256' docs/cookbook/webhooks.md`
   - `test -f docs/deprecation-policy.md && grep -q 'experimental' docs/deprecation-policy.md`
   - `grep -q '5 formats frozen' docs/architecture.md`
4. CI file gate: `grep -q 'test:contract' .github/workflows/ci.yml`
5. Open a synthetic PR on a scratch branch with a deliberate error envelope regression (e.g., remove `requestId` field from error-handler.ts) — confirm CI fails on the new test:contract job. (Manual check.)
</verification>

<success_criteria>
- API-12: `tests/contract/` runs in CI on every PR; matrix driver covers every route × every status × every example. Verified by CI workflow + 6 test files passing.
- API-07 (timestamp test gate), API-10 (versioning test gate), API-13 (experimental scaffolding test) — all explicit tests green.
- API-08, API-09, API-11, API-13 (doc side): 5 docs committed and grep-validated.
- Ajv2020 imported via `from 'ajv/dist/2020'` everywhere — Pitfall #1 protection.
- tests/contract/ uses Node-builtin http.Server (no @hono/node-server at workspace root) — Phase 15 carry-forward.
- Existing test:carveout + test:private-contract jobs still green (no regression).
</success_criteria>

<output>
After completion, create `.planning/phases/16-api-contract-sdk-packages/16-4-SUMMARY.md` recording:
- Number of (path, method, status, example) tuples discovered in the OpenAPI spec
- Number of tuples that triggered Ajv validation failures (should be 0 after Task 2 lands)
- Contract suite runtime (wall-clock seconds) on local + CI
- Any OpenAPI example tuples that had to be fixed in route handlers (e.g., legacy examples with old error code shape)
- Doc file inventory: line counts for each new doc
- Plan 16-5 dependencies: confirm tests/contract/ + docs are in place; release infra builds on top
</output>
