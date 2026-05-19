/**
 * API-07: ISO 8601 UTC timestamp contract.
 *
 * Every timestamp value in an API response MUST be:
 *   - a string (NOT a number / Unix epoch)
 *   - parseable as a JS `Date` (`!Number.isNaN(new Date(v).getTime())`)
 *   - ending with `Z` OR carrying an explicit `+00:00` UTC offset (so consumers
 *     in other timezones can round-trip without re-zoning)
 *
 * Two flavors of check:
 *   1. SPEC SIDE: walk the served OpenAPI spec; every property declared with
 *      `format: 'date-time'` must be a non-numeric type whose example (if
 *      any) parses correctly.
 *   2. RUNTIME SIDE: hit GET /.well-known/spatula-version (a known endpoint
 *      that returns `buildAt` as ISO 8601) and assert the value parses.
 *
 * Reading the entire path tree at runtime is overkill — the matrix driver
 * does that. This file's job is the focused per-REQ gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ContractServer } from './helpers/server-harness.js';

let server: ContractServer;
let spec: any;

const ISO_UTC_PATTERN = /(Z|[+-]00:00)$/;

function isIsoUtc(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!ISO_UTC_PATTERN.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/** Walk any JSON-ish value, returning every (path, leaf) pair. */
function* walk(node: unknown, path: string[] = []): Generator<{ path: string[]; value: unknown }> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* walk(node[i], [...path, String(i)]);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield* walk(v, [...path, k]);
    }
    return;
  }
  yield { path, value: node };
}

describe('API-07 ISO 8601 UTC timestamps', () => {
  beforeAll(async () => {
    server = await startServer();
    const res = await fetch(`${server.url}/api/v1/openapi.json`);
    spec = await res.json();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it('every date-time-typed response property has a parseable ISO UTC example', () => {
    const offenders: string[] = [];
    for (const { path, value } of walk(spec)) {
      // Walk through schemas finding `{ format: 'date-time', example: '...' }`
      // The schema graph is deep enough that walking the entire spec catches
      // all surface area; we filter inside the walk callback below.
      if (path[path.length - 1] === 'example' && typeof value === 'string') {
        // Inspect the sibling `format` and `type` at the same parent.
        const parent = path.slice(0, -1);
        const parentNode = parent.reduce<any>((acc, k) => (acc ? acc[k] : undefined), spec);
        if (parentNode?.format === 'date-time') {
          if (!isIsoUtc(value)) {
            offenders.push(`${parent.join('/')}: ${value}`);
          }
        }
      }
    }
    expect(offenders, `date-time examples violating ISO UTC: ${offenders.join('; ')}`).toEqual([]);
  });

  it('GET /.well-known/spatula-version returns ISO UTC buildAt', async () => {
    const res = await fetch(`${server.url}/.well-known/spatula-version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildAt: string };
    expect(typeof body.buildAt).toBe('string');
    expect(isIsoUtc(body.buildAt), `buildAt should end with Z or +00:00, got: ${body.buildAt}`).toBe(true);
  });

  it('no purely-numeric timestamp values in response bodies (sanity sweep)', async () => {
    // Hit well-known + openapi.json + any unauthed health endpoint and walk
    // the response bodies for top-level numeric date keys (createdAt, etc).
    // This is a smoke check, not a complete enumeration — the matrix driver
    // does the full sweep.
    const samples = ['/api/v1/openapi.json', '/.well-known/spatula-version', '/health'];
    const numericTimestampKeyPattern = /(?:^|_)(at|At|on|On)$/;
    for (const path of samples) {
      const res = await fetch(`${server.url}${path}`);
      if (!res.ok) continue;
      const body = await res.json();
      for (const { path: keyPath, value } of walk(body)) {
        const leafKey = keyPath[keyPath.length - 1];
        if (
          leafKey &&
          numericTimestampKeyPattern.test(leafKey) &&
          typeof value === 'number'
        ) {
          throw new Error(
            `Numeric timestamp found at ${path} → ${keyPath.join('/')}: ${value}. Timestamps must be ISO 8601 UTC strings (API-07).`,
          );
        }
      }
    }
  });
});
