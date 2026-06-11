/**
 * Integration tests for POST /api/v1/api-keys/:id/rotate (AUTH-05).
 *
 * Uses createApp() with a stateful mock ApiKeyRepository that mirrors real
 * DB behavior — same pattern as other apps/api integration tests.
 *
 * Covers:
 *   - 200: creates new key with sk_live_ prefix, scopes match original, lineage fields set
 *   - Old key still authenticates during grace window (findByHash returns it)
 *   - Post-grace expiry: setting old key expiresAt to past → findByHash returns null
 *   - graceSeconds over cap (700000) is clamped to 604800 (~7d supersededExpiresAt)
 *   - Non-existent key id → 404 RESOURCE.NOT_FOUND
 *   - Already-revoked key → 409 JOB.INVALID_STATE
 *   - Audit event api_key.rotated emitted with both key ids
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/types.js';
import type { Pool } from 'pg';

// ── Stateful mock key store ───────────────────────────────────────────────────

type KeyRow = {
  id: string;
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  supersedes: string | null;
  supersededExpiresAt: Date | null;
  lastUsedAt: Date | null;
};

function createKeyStore() {
  const keys = new Map<string, KeyRow>();
  let idCounter = 1;

  return {
    keys,
    addKey(
      row: Partial<KeyRow> & {
        id: string;
        tenantId: string;
        keyHash: string;
        keyPrefix: string;
        name: string;
        scopes: string[];
      },
    ): KeyRow {
      const full: KeyRow = {
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
        supersedes: null,
        supersededExpiresAt: null,
        lastUsedAt: null,
        ...row,
      };
      keys.set(full.id, full);
      return full;
    },
    nextId(): string {
      return `key-id-${idCounter++}`;
    },
  };
}

/**
 * Build a mock ApiKeyRepository backed by a key store that mimics the real
 * rotate() behavior (including grace window).
 */
function buildMockApiKeyRepo(store: ReturnType<typeof createKeyStore>) {
  return {
    async create(input: {
      tenantId: string;
      keyHash: string;
      keyPrefix: string;
      name: string;
      scopes: string[];
      expiresAt?: Date;
    }) {
      const id = store.nextId();
      return store.addKey({ id, ...input, expiresAt: input.expiresAt ?? null });
    },

    async findByHash(keyHash: string) {
      for (const key of store.keys.values()) {
        if (
          key.keyHash === keyHash &&
          !key.revokedAt &&
          (key.expiresAt === null || key.expiresAt > new Date())
        ) {
          return key;
        }
      }
      return null;
    },

    async listByTenant(tenantId: string) {
      return Array.from(store.keys.values()).filter((k) => k.tenantId === tenantId && !k.revokedAt);
    },

    async revoke(keyId: string, tenantId: string) {
      const key = store.keys.get(keyId);
      if (!key || key.tenantId !== tenantId) {
        const { StorageError } = await import('@spatula/shared');
        throw new StorageError(`API key ${keyId} not found`, { context: { keyId, tenantId } });
      }
      key.revokedAt = new Date();
      return key;
    },

    async rotate(
      keyId: string,
      tenantId: string,
      newKeyMaterial: { keyHash: string; keyPrefix: string },
      graceSeconds: number,
    ) {
      const { StorageError } = await import('@spatula/shared');
      const orig = store.keys.get(keyId);
      if (!orig || orig.tenantId !== tenantId) {
        throw new StorageError(`API key ${keyId} not found`, { context: { keyId, tenantId } });
      }
      if (orig.revokedAt) {
        throw new StorageError(`API key ${keyId} is already revoked and cannot be rotated`, {
          context: { keyId },
        });
      }

      const graceUntil = new Date(Date.now() + graceSeconds * 1000);

      // Insert new key
      const newId = store.nextId();
      const newKey = store.addKey({
        id: newId,
        tenantId,
        keyHash: newKeyMaterial.keyHash,
        keyPrefix: newKeyMaterial.keyPrefix,
        name: `${orig.name} (rotated)`,
        scopes: [...orig.scopes],
        supersedes: orig.id,
        supersededExpiresAt: graceUntil,
      });

      // Grace-expire old key
      orig.expiresAt = graceUntil;

      return { oldKey: orig, newKey };
    },
  };
}

// ── Mock deps factory ─────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-000000000099';
const ORIG_KEY_ID = 'orig-key-001';
const ORIG_KEY_RAW = 'sk_live_test_original_key_value';
const ORIG_KEY_HASH = 'sha256-of-original-key';

function createMockDeps(
  overrides: Partial<AppDeps> & { keyStore?: ReturnType<typeof createKeyStore> } = {},
): AppDeps & { keyStore: ReturnType<typeof createKeyStore>; auditSpy: ReturnType<typeof vi.fn> } {
  const keyStore = overrides.keyStore ?? createKeyStore();

  // Pre-seed original key
  if (!keyStore.keys.has(ORIG_KEY_ID)) {
    keyStore.addKey({
      id: ORIG_KEY_ID,
      tenantId: TENANT_ID,
      keyHash: ORIG_KEY_HASH,
      keyPrefix: 'sk_live_tes',
      name: 'Original Key',
      scopes: ['jobs:read', 'jobs:write'],
    });
  }

  const auditSpy = vi.fn();

  const mockRedis: any = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    getdel: vi.fn().mockResolvedValue(null),
    eval: vi.fn().mockResolvedValue([100, 50, Date.now() + 60000]),
    xrange: vi.fn().mockResolvedValue([]),
    xread: vi.fn().mockResolvedValue(null),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1000-0'),
    quit: vi.fn().mockResolvedValue('OK'),
    subscribe: vi.fn(),
    publish: vi.fn(),
    on: vi.fn(),
  };

  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    redis: mockRedis,
    apiKeyRepo: buildMockApiKeyRepo(keyStore) as any,
    auditLogger: { log: auditSpy } as any,
    jobRepo: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByTenant: vi.fn().mockResolvedValue([]),
      countByTenant: vi.fn().mockResolvedValue(0),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(null),
      findAllVersions: vi.fn().mockResolvedValue([]),
      findByVersion: vi.fn().mockResolvedValue(null),
    },
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    entitySourceRepo: {
      findByEntity: vi.fn().mockResolvedValue([]),
      findByEntityWithUrls: vi.fn().mockResolvedValue([]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
      countByJobAndStatus: vi.fn().mockResolvedValue(0),
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [], nextCursor: null }),
    },
    taskRepo: {} as any,
    exportRepo: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByJob: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
    },
    contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() },
    exportQueue: { add: vi.fn() },
    jobManager: {
      createJob: vi.fn().mockResolvedValue('job-1'),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
      getJobStatus: vi.fn().mockResolvedValue('pending'),
    },
    keyStore,
    auditSpy,
    ...overrides,
  } as unknown as AppDeps & {
    keyStore: ReturnType<typeof createKeyStore>;
    auditSpy: ReturnType<typeof vi.fn>;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/api-keys/:id/rotate (AUTH-05)', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // ── Happy path: 200 response shape ─────────────────────────────────────────

  it('returns 200 with new raw key (sk_live_ prefix), scopes equal original, lineage fields set', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT_ID,
      },
      body: JSON.stringify({ graceSeconds: 86400 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const data = body.data;

    // New raw key starts with sk_live_
    expect(data.key).toMatch(/^sk_live_/);
    // Scopes inherited verbatim from original key
    expect(data.scopes).toEqual(['jobs:read', 'jobs:write']);
    // Lineage: supersedes = original key id
    expect(data.supersedes).toBe(ORIG_KEY_ID);
    // supersededExpiresAt is set (~24h in future)
    expect(data.supersededExpiresAt).toBeDefined();
    const graceExpiry = new Date(data.supersededExpiresAt).getTime();
    const now = Date.now();
    expect(graceExpiry).toBeGreaterThan(now + 23 * 3600 * 1000); // > 23h from now
    expect(graceExpiry).toBeLessThan(now + 25 * 3600 * 1000); // < 25h from now
  });

  // ── Grace window: old key still authenticates ──────────────────────────────

  it('old key still authenticates via findByHash during grace window', async () => {
    const app = createApp(deps);
    // Rotate the key
    await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({ graceSeconds: 3600 }),
    });

    // Old key should still be findable — expiresAt is 1h in future
    const oldKeyRow = await (deps.apiKeyRepo as any).findByHash(ORIG_KEY_HASH);
    expect(oldKeyRow).not.toBeNull();
    expect(oldKeyRow.id).toBe(ORIG_KEY_ID);
    // expiresAt should be in future (grace window)
    expect(oldKeyRow.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // ── Post-grace expiry: old key is rejected after expiresAt passes ──────────

  it('old key returns null from findByHash after expiresAt is set to the past', async () => {
    const app = createApp(deps);
    // Rotate with 3600s grace
    await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({ graceSeconds: 3600 }),
    });

    // Directly set the old key's expiresAt to the past (DB-direct manipulation pattern)
    const oldKeyRow = deps.keyStore.keys.get(ORIG_KEY_ID)!;
    oldKeyRow.expiresAt = new Date(Date.now() - 1000);

    // Now findByHash should return null — old key is expired
    const result = await (deps.apiKeyRepo as any).findByHash(ORIG_KEY_HASH);
    expect(result).toBeNull();
  });

  // ── graceSeconds clamping ──────────────────────────────────────────────────

  it('graceSeconds over 604800 is clamped — supersededExpiresAt is ~7 days out, not ~8.1 days', async () => {
    const app = createApp(deps);
    const beforeCall = Date.now();

    const res = await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({ graceSeconds: 700000 }), // over 604800 cap
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const graceExpiry = new Date(body.data.supersededExpiresAt).getTime();
    const afterCall = Date.now();

    // Should be ~604800s not ~700000s from now
    const maxExpected = afterCall + 604800 * 1000 + 1000; // +1s tolerance
    const minExpected = beforeCall + 604800 * 1000 - 1000; // -1s tolerance
    expect(graceExpiry).toBeGreaterThan(minExpected);
    expect(graceExpiry).toBeLessThan(maxExpected);

    // Not 700000s out
    const unclamped = beforeCall + 700000 * 1000;
    expect(graceExpiry).toBeLessThan(unclamped);
  });

  // ── graceSeconds: default when body is absent ──────────────────────────────

  it('defaults to 86400s grace when body is absent', async () => {
    const app = createApp(deps);
    const beforeCall = Date.now();

    const res = await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': TENANT_ID },
      // no body
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const graceExpiry = new Date(body.data.supersededExpiresAt).getTime();
    const afterCall = Date.now();

    expect(graceExpiry).toBeGreaterThan(beforeCall + 86400 * 1000 - 1000);
    expect(graceExpiry).toBeLessThan(afterCall + 86400 * 1000 + 1000);
  });

  // ── 404: non-existent key ──────────────────────────────────────────────────

  it('returns 404 with RESOURCE.NOT_FOUND for a non-existent key id', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/api-keys/does-not-exist/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('RESOURCE.NOT_FOUND');
  });

  // ── 409: already-revoked key ───────────────────────────────────────────────

  it('returns 409 with JOB.INVALID_STATE when rotating an already-revoked key', async () => {
    // Revoke the original key first
    const origKey = deps.keyStore.keys.get(ORIG_KEY_ID)!;
    origKey.revokedAt = new Date();

    const app = createApp(deps);
    const res = await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('JOB.INVALID_STATE');
  });

  // ── Audit event ────────────────────────────────────────────────────────────

  it('emits api_key.rotated audit event with new key id as resourceId and old key id in metadata', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/v1/api-keys/${ORIG_KEY_ID}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify({ graceSeconds: 86400 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const newKeyId = body.data.id;

    // Find the api_key.rotated audit call (auth middleware also emits its own audit events)
    const allCalls = (deps as any).auditSpy.mock.calls.map((c: any[]) => c[0]);
    const rotatedCall = allCalls.find((c: any) => c.action === 'api_key.rotated');
    expect(rotatedCall).toBeDefined();
    expect(rotatedCall.action).toBe('api_key.rotated');
    expect(rotatedCall.resourceId).toBe(newKeyId);
    expect(rotatedCall.metadata.supersedes).toBe(ORIG_KEY_ID);
    expect(rotatedCall.tenantId).toBe(TENANT_ID);
  });
});
