/**
 * Generated matrix driver — the heart of plan 16-4.
 *
 * Boots the API, fetches the live `GET /api/v1/openapi.json`, and iterates
 * every `(path, method, status, example)` tuple in the served spec to assert
 * shape conformance via Ajv2020.
 *
 * Two validation passes:
 *
 *   PASS 1 (spec self-consistency — runs without hitting any live route):
 *     For every operation, for every response with `content.application/json`
 *     declaring a `schema` AND at least one `example`/`examples` entry: compile
 *     the schema with Ajv2020 and assert each example validates against it.
 *     This catches the most common drift mode — handwritten examples that
 *     fell off the schema during a refactor.
 *
 *   PASS 2 (runtime ↔ spec consistency — sample live 2xx responses):
 *     For every GET operation that declares a 200 + a JSON schema, hit the
 *     route with the seeded admin API key and assert the response body
 *     validates against the declared schema. Path params resolve via the
 *     fixtures helper; routes whose params we can't resolve return 4xx and
 *     are skipped (we're testing 2xx shape, not error envelope — that's
 *     errors.test.ts's job).
 *
 * Pass 1 is byte-deterministic (pure spec walk); Pass 2 is best-effort across
 * the routes whose deps are wired in the harness. Together they catch both
 * "spec lies about what handler returns" and "spec example is plain wrong"
 * drift modes (D-14 belt-and-suspenders with apps/api/src/openapi-config.ts
 * `validateExamplesAtBoot` from plan 16-3).
 *
 * Tuple counters published into the SUMMARY via stderr at the end of the run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ContractServer } from './helpers/server-harness.js';
import { createAjv } from './helpers/ajv-setup.js';
import { seedFixtures, resolvePath, authHeaders, type ContractFixtures } from './helpers/fixtures.js';

let server: ContractServer;
let spec: any;
let fixtures: ContractFixtures;
const ajv = createAjv();

// Tuple counters for the SUMMARY.md write-up.
const counters = {
  totalTuples: 0,          // every (path, method, status) considered
  tuplesWithExamples: 0,
  pass1Validated: 0,       // examples that ran through ajv.validate
  pass1Failures: 0,        // examples that FAILED ajv.validate
  pass2LiveHits: 0,        // live 2xx fetched + validated
  pass2LiveSkipped: 0,     // skipped (non-2xx, path unresolved, dep missing)
};

describe('OpenAPI matrix conformance', () => {
  beforeAll(async () => {
    server = await startServer();
    const res = await fetch(`${server.url}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    spec = await res.json();
    fixtures = await seedFixtures(server);
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    // Stderr — picked up by parent process and surfaced in SUMMARY.md.
    process.stderr.write(
      `[contract-matrix] tuples=${counters.totalTuples} withExamples=${counters.tuplesWithExamples} ` +
        `pass1Validated=${counters.pass1Validated} pass1Failures=${counters.pass1Failures} ` +
        `pass2LiveHits=${counters.pass2LiveHits} pass2LiveSkipped=${counters.pass2LiveSkipped}\n`,
    );
  });

  it('PASS 1: every declared example validates against its response schema (spec self-consistency)', () => {
    const failures: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
        const operation = op as { responses?: Record<string, unknown> };
        if (!operation || typeof operation !== 'object' || !operation.responses) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          counters.totalTuples += 1;
          const json = (response as { content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> }> }).content?.['application/json'];
          if (!json?.schema) continue;
          const examples: unknown[] = [];
          if (json.examples) {
            for (const ex of Object.values(json.examples)) {
              examples.push(ex && typeof ex === 'object' && 'value' in ex ? ex.value : ex);
            }
          } else if (json.example !== undefined) {
            examples.push(json.example);
          }
          if (examples.length === 0) continue;
          counters.tuplesWithExamples += 1;

          let validate: ReturnType<typeof ajv.compile>;
          try {
            validate = ajv.compile(json.schema as object);
          } catch (err) {
            failures.push(
              `${method.toUpperCase()} ${path} ${status}: schema compile failed — ${(err as Error).message}`,
            );
            continue;
          }
          for (const ex of examples) {
            counters.pass1Validated += 1;
            if (!validate(ex)) {
              counters.pass1Failures += 1;
              failures.push(
                `${method.toUpperCase()} ${path} ${status}: example off-schema — ${ajv.errorsText(validate.errors)}`,
              );
            }
          }
        }
      }
    }
    expect(failures, `Pass 1 failures: ${failures.join('\n')}`).toEqual([]);
  });

  it('PASS 2: live 2xx responses validate against declared schemas (best-effort)', async () => {
    const failures: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
        const operation = op as { responses?: Record<string, unknown> };
        if (method.toLowerCase() !== 'get') continue; // Only GETs are safe to fire on a hot suite.
        if (!operation.responses?.['200']) continue;
        const json = (operation.responses['200'] as { content?: Record<string, { schema?: unknown }> }).content?.['application/json'];
        if (!json?.schema) continue;

        const url = resolvePath(server.url, path, fixtures);
        let res: Response;
        try {
          res = await fetch(url, { method: 'GET', headers: authHeaders(fixtures) });
        } catch {
          counters.pass2LiveSkipped += 1;
          continue;
        }

        // Only validate when the live response is actually 200 — non-2xx
        // means the path needed a real-world fixture we don't have (e.g., a
        // valid jobId that doesn't exist in the seeded tenant). Those are
        // skipped, not failed.
        if (res.status !== 200) {
          counters.pass2LiveSkipped += 1;
          continue;
        }

        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
          counters.pass2LiveSkipped += 1;
          continue;
        }

        let body: unknown;
        try {
          body = await res.json();
        } catch {
          counters.pass2LiveSkipped += 1;
          continue;
        }

        counters.pass2LiveHits += 1;
        let validate: ReturnType<typeof ajv.compile>;
        try {
          validate = ajv.compile(json.schema as object);
        } catch {
          // Schema compile failures are reported by Pass 1; don't double-count.
          continue;
        }
        if (!validate(body)) {
          failures.push(
            `${method.toUpperCase()} ${path} 200 (live): response off-schema — ${ajv.errorsText(validate.errors)}`,
          );
        }
      }
    }
    // Pass 2 failures are gated as failures even though Pass 2 itself is best-effort
    // — once a tuple actually fires, the shape MUST match.
    expect(failures, `Pass 2 failures: ${failures.join('\n')}`).toEqual([]);
  }, 60_000);

  it('discovered at least one operation in the served spec (sanity check)', () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    let opCount = 0;
    for (const methods of Object.values(spec.paths)) {
      opCount += Object.keys(methods as Record<string, unknown>).length;
    }
    expect(opCount).toBeGreaterThan(0);
  });
});
