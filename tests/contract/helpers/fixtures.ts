/**
 * Shared fixture seeding for the contract suite.
 *
 * The matrix driver in generated.test.ts walks every (path, method) in the
 * served OpenAPI spec. Many paths contain `:jobId`, `:entityId`, `:exportId`
 * params — `seedFixtures` provides a single set of IDs the driver can plug into
 * those placeholders. Helpers (`resolvePath`, `authHeaders`) further down keep
 * the matrix-driver loop bodies short.
 *
 * Sole consumer: tests/contract/**.test.ts. Not exported beyond the suite.
 */

import {
  seedTenantAndKey,
  type ContractServer,
  type SeededIdentity,
} from './server-harness.js';

export interface ContractFixtures extends SeededIdentity {
  /** Sentinel UUIDv4 for synthetic NOT_FOUND assertions. */
  bogusUuid: string;
  /** Real job created against the seeded tenant — populated lazily; jobId may be empty if the create fails (workers absent). */
  jobId: string;
  /** Real entity id (if any). Populated lazily. */
  entityId: string;
}

/**
 * Seed a tenant + admin-scoped API key and return the fixture pack. Attempts to
 * create one job and one entity for path-param resolution; tolerates failure
 * (the test fixture deps in server-harness.ts stub out workers, so the create
 * may 500 — that's fine; the matrix driver skips paths whose params we don't
 * have).
 *
 * @param server The handle returned by `startServer()`.
 */
export async function seedFixtures(
  server: ContractServer,
): Promise<ContractFixtures> {
  const identity = await seedTenantAndKey(server, 'contract-suite-tenant');

  const bogusUuid = '00000000-0000-0000-0000-000000000000';

  // Best-effort job creation. The stubbed deps make this likely to fail —
  // that's expected; the matrix driver skips jobId-bound paths if the value is
  // empty. The explicit per-REQ suites (errors.test.ts, etc.) hit fixed
  // 404-trigger paths instead, so they don't need a real jobId.
  let jobId = '';
  try {
    const res = await fetch(`${server.url}/api/v1/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identity.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'contract-suite-job',
        seedUrls: ['https://example.com'],
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      if (body.id) jobId = body.id;
    }
  } catch {
    // Tolerated — see comment above.
  }

  return {
    ...identity,
    bogusUuid,
    jobId,
    entityId: '', // Reserved for future suites that need a real entity.
  };
}

/**
 * Resolve an OpenAPI path template (e.g., `/jobs/{jobId}/entities/{entityId}`)
 * against a fixture pack. Unknown params fall through to the bogus-UUID
 * sentinel so the URL is at least well-formed (the matrix driver treats the
 * resulting 404 as a clean miss, not a shape violation).
 */
export function resolvePath(
  baseUrl: string,
  path: string,
  fx: ContractFixtures,
): string {
  // Support both {param} (OpenAPI) and :param (Hono) styles.
  const resolved = path
    .replace('{jobId}', fx.jobId || fx.bogusUuid)
    .replace(':jobId', fx.jobId || fx.bogusUuid)
    .replace('{entityId}', fx.entityId || fx.bogusUuid)
    .replace(':entityId', fx.entityId || fx.bogusUuid)
    .replace('{tenantId}', fx.tenantId)
    .replace(':tenantId', fx.tenantId)
    .replace(/\{[^}]+\}/g, fx.bogusUuid) // any remaining
    .replace(/:([a-zA-Z]+)/g, fx.bogusUuid);
  return `${baseUrl}${resolved}`;
}

/** Standard Authorization header pack for the seeded admin-scope API key. */
export function authHeaders(fx: ContractFixtures): Record<string, string> {
  return {
    Authorization: `Bearer ${fx.apiKey}`,
    'Content-Type': 'application/json',
  };
}
