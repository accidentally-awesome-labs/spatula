# Wave 5-4: Remote Config & Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable CLI users to configure remote Spatula servers, push local project configs to create remote jobs, and control remote job lifecycle — bridging the local CLI experience with the hosted platform.

**Architecture:** Extend `SpatulaApiClient` with API key auth support, add `saveGlobalConfig` for persisting remote entries, implement `remote` (add/list/remove/status/pause/resume/cancel/watch) and `push` CLI commands that store job links in local `project_meta`, and create `ApiDataSource` wrapping the API client to implement the `DataSource` interface for remote data access.

**Tech Stack:** TypeScript, Yargs (CLI), Vitest, `yaml` (config persistence), `SpatulaApiClient` (HTTP), `useWebSocket` (WS), `ProjectMetaRepository` (SQLite kv)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/cli/src/commands/remote.ts` | `remote add/list/remove/status/pause/resume/cancel` command logic |
| `apps/cli/src/commands/push.ts` | `push` command — transform YAML → JobConfig, POST to remote, store link |
| `apps/cli/src/commands/remote-watch.tsx` | `remote watch` — Ink TUI connecting to remote WebSocket |
| `apps/cli/src/data-sources/api-data-source.ts` | `ApiDataSource` implementing `DataSource` via `SpatulaApiClient` |
| `apps/cli/tests/unit/commands/remote.test.ts` | Tests for remote add/list/remove/status/pause/resume/cancel |
| `apps/cli/tests/unit/commands/push.test.ts` | Tests for push command |
| `apps/cli/tests/unit/commands/remote-watch.test.ts` | Tests for remote watch |
| `apps/cli/tests/unit/data-sources/api-data-source.test.ts` | Tests for ApiDataSource |
| `apps/cli/tests/unit/api/client-auth.test.ts` | Tests for SpatulaApiClient auth header injection + new methods |

### Modified files

| File | Change |
|------|--------|
| `apps/cli/src/api/client.ts` | Add optional `apiKey` to constructor, inject `Authorization` header, add `getSubscription()`, `getEntitiesStream()`, `getWsToken()` methods |
| `packages/core/src/config/global-config.ts` | Add `saveGlobalConfig()` function |
| `packages/core/src/config/index.ts` | Export `saveGlobalConfig` |
| `apps/cli/src/index.tsx` | Register `remote` and `push` commands |
| `apps/cli/src/hooks/useWebSocket.ts` | Support optional `token` query param for authenticated WS connections |
| `apps/cli/src/components/dashboard/DashboardView.tsx` | Add optional `wsToken` prop, pass to `useWebSocket` |
| `apps/cli/src/local-project.ts` | Expose `metaRepo` on `LocalProject` for remote link access |

---

## Task 1: SpatulaApiClient — Auth Header Support

**Files:**
- Modify: `apps/cli/src/api/client.ts`
- Test: `apps/cli/tests/unit/api/client-auth.test.ts`

- [ ] **Step 1: Write failing tests for auth header injection**

```typescript
// apps/cli/tests/unit/api/client-auth.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';

function mockFetchOk(data: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    }),
  );
}

function lastFetchHeaders(): Record<string, string> {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[calls.length - 1][1] as RequestInit).headers as Record<string, string>;
}

afterEach(() => vi.restoreAllMocks());

describe('SpatulaApiClient auth', () => {
  it('does NOT send Authorization header when no apiKey', async () => {
    mockFetchOk([]);
    const client = new SpatulaApiClient('http://localhost:3000', 'tenant-1');
    await client.listJobs();
    const headers = lastFetchHeaders();
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['x-tenant-id']).toBe('tenant-1');
  });

  it('sends Authorization header when apiKey is provided', async () => {
    mockFetchOk([]);
    const client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test_abc123',
    });
    await client.listJobs();
    const headers = lastFetchHeaders();
    expect(headers.Authorization).toBe('Bearer sk_test_abc123');
    expect(headers['x-tenant-id']).toBe('tenant-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && npx vitest run tests/unit/api/client-auth.test.ts`
Expected: FAIL — constructor does not accept third argument

- [ ] **Step 3: Implement auth header support**

In `apps/cli/src/api/client.ts`, update the constructor and `headers()` method:

```typescript
// Replace the existing constructor and headers:

export interface SpatulaApiClientOptions {
  apiKey?: string;
}

export class SpatulaApiClient {
  public readonly baseUrl: string;
  public readonly tenantId: string;
  private readonly apiKey?: string;

  constructor(baseUrl: string, tenantId: string, options?: SpatulaApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tenantId = tenantId;
    this.apiKey = options?.apiKey;
  }

  // ... all existing methods unchanged ...

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': this.tenantId,
    };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/api/client-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/unit/api/client-auth.test.ts
git commit -m "feat(cli): add API key auth support to SpatulaApiClient"
```

---

## Task 2: SpatulaApiClient — New Methods

**Files:**
- Modify: `apps/cli/src/api/client.ts`
- Test: `apps/cli/tests/unit/api/client-auth.test.ts` (append)

- [ ] **Step 1: Write failing tests for new methods**

Append to `apps/cli/tests/unit/api/client-auth.test.ts`:

```typescript
describe('SpatulaApiClient new methods', () => {
  let client: SpatulaApiClient;

  beforeEach(() => {
    client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test_key',
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('getSubscription calls GET /api/v1/billing/subscription', async () => {
    const sub = { plan: 'free', limits: {}, usage: {} };
    mockFetchOk(sub);
    const result = await client.getSubscription();
    expect(result).toEqual(sub);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/api/v1/billing/subscription');
  });

  it('getEntitiesStream calls entities endpoint with cursor/since params', async () => {
    mockFetchOk({ data: [], cursor: null });
    await client.getEntitiesStream('job-1', { cursor: 'abc', since: '2026-01-01', limit: 200 });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const url = calls[0][0] as string;
    expect(url).toContain('/api/v1/jobs/job-1/entities');
    expect(url).toContain('cursor=abc');
    expect(url).toContain('since=2026-01-01');
    expect(url).toContain('limit=200');
  });

  it('getWsToken calls POST /api/v1/ws-token', async () => {
    mockFetchOk({ token: 'tok_abc', expiresIn: 60 });
    const result = await client.getWsToken();
    expect(result).toEqual({ token: 'tok_abc', expiresIn: 60 });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/api/v1/ws-token');
    expect((calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('getHealth calls GET /health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok' }),
      }),
    );
    const result = await client.getHealth();
    expect(result).toEqual({ status: 'ok' });
  });
});
```

Add `import { beforeEach } from 'vitest';` to the existing imports at the top of the file (if not already present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && npx vitest run tests/unit/api/client-auth.test.ts`
Expected: FAIL — methods do not exist

- [ ] **Step 3: Add new methods to SpatulaApiClient**

In `apps/cli/src/api/client.ts`, add these methods after the existing `approveAllActions` method:

```typescript
  // -----------------------------------------------------------------------
  // Billing (for remote verification)
  // -----------------------------------------------------------------------

  async getSubscription(): Promise<Record<string, unknown>> {
    return this.get('/api/v1/billing/subscription');
  }

  // -----------------------------------------------------------------------
  // Entity streaming (for pull flow)
  // -----------------------------------------------------------------------

  async getEntitiesStream(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/entities`, query);
  }

  // -----------------------------------------------------------------------
  // WebSocket token
  // -----------------------------------------------------------------------

  async getWsToken(): Promise<{ token: string; expiresIn: number }> {
    return this.post('/api/v1/ws-token');
  }

  // -----------------------------------------------------------------------
  // Health check (raw — not wrapped in { data })
  // -----------------------------------------------------------------------

  async getHealth(): Promise<Record<string, unknown>> {
    const url = this.buildUrl('/health');
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', message);
    }
    if (!response.ok) {
      throw new ApiError(response.status, undefined, `HTTP ${response.status}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/api/client-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Run all existing client tests to check for regressions**

Run: `cd apps/cli && npx vitest run tests/unit/api/ tests/unit/commands/status.test.ts tests/unit/commands/list.test.ts`
Expected: All PASS (constructor change is backward-compatible — `options` is optional)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/unit/api/client-auth.test.ts
git commit -m "feat(cli): add getSubscription, getEntitiesStream, getWsToken, getHealth to API client"
```

---

## Task 3: saveGlobalConfig Utility

**Files:**
- Modify: `packages/core/src/config/global-config.ts`
- Modify: `packages/core/src/config/index.ts`
- Test: `packages/core/tests/unit/config/global-config.test.ts` (append)

- [ ] **Step 1: Write failing test for saveGlobalConfig**

Find the existing test file and append a new describe block:

```typescript
// Append to packages/core/tests/unit/config/global-config.test.ts

describe('saveGlobalConfig', () => {
  it('writes YAML to the config path, creating directory if needed', async () => {
    const tmpDir = join(tmpdir(), `spatula-save-test-${Date.now()}`);
    const configPath = join(tmpDir, 'config.yaml');

    const config: GlobalConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
      },
    };

    saveGlobalConfig(config, configPath);

    const reloaded = loadGlobalConfig(configPath);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(reloaded!.remotes?.prod?.apiKey).toBe('sk_live_abc');

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges with existing config when merge flag is true', async () => {
    const tmpDir = join(tmpdir(), `spatula-merge-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'config.yaml');

    // Write initial config
    saveGlobalConfig({ version: 1, crawler: 'playwright' } as GlobalConfig, configPath);

    // Merge new remote
    const patch: Partial<GlobalConfig> = {
      remotes: { staging: { url: 'https://staging.spatula.dev' } },
    };
    saveGlobalConfig(patch as GlobalConfig, configPath, { merge: true });

    const reloaded = loadGlobalConfig(configPath);
    expect(reloaded!.crawler).toBe('playwright');
    expect(reloaded!.remotes?.staging?.url).toBe('https://staging.spatula.dev');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

Add the needed imports at the top of the test file: `import { saveGlobalConfig } from '../../../src/config/global-config.js';` and `import { rmSync, mkdirSync } from 'node:fs';` and `import { tmpdir } from 'node:os';` and `import { join } from 'node:path';` (some may already exist).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/unit/config/global-config.test.ts`
Expected: FAIL — `saveGlobalConfig` does not exist

- [ ] **Step 3: Implement saveGlobalConfig**

In `packages/core/src/config/global-config.ts`, add:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';  // add to existing imports
import { dirname } from 'node:path';                   // add to existing imports
import { stringify as stringifyYaml } from 'yaml';      // add new import

export interface SaveGlobalConfigOptions {
  merge?: boolean;
}

/**
 * Save global config to ~/.spatula/config.yaml (or the given path).
 * Creates the directory if it does not exist.
 * When merge is true, deep-merges with existing config.
 */
export function saveGlobalConfig(
  config: GlobalConfig,
  configPath?: string,
  options?: SaveGlobalConfigOptions,
): void {
  const path = configPath ?? getGlobalConfigPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let toWrite = config;
  if (options?.merge) {
    const existing = loadGlobalConfig(path);
    if (existing) {
      toWrite = { ...existing, ...config };
      // Deep-merge remotes specifically
      if (existing.remotes || config.remotes) {
        toWrite.remotes = { ...existing.remotes, ...config.remotes };
      }
    }
  }

  writeFileSync(path, stringifyYaml(toWrite, { lineWidth: 0 }), 'utf-8');
}
```

- [ ] **Step 4: Export saveGlobalConfig from index.ts**

In `packages/core/src/config/index.ts`, update the global-config export line:

```typescript
export { loadGlobalConfig, getGlobalConfigPath, saveGlobalConfig } from './global-config.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/unit/config/global-config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/global-config.ts packages/core/src/config/index.ts packages/core/tests/unit/config/global-config.test.ts
git commit -m "feat(core): add saveGlobalConfig utility with merge support"
```

---

## Task 4: Remote Add Command

**Files:**
- Create: `apps/cli/src/commands/remote.ts`
- Test: `apps/cli/tests/unit/commands/remote.test.ts`

- [ ] **Step 1: Write failing tests for remote add**

```typescript
// apps/cli/tests/unit/commands/remote.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runRemoteAdd, runRemoteList, runRemoteRemove } from '../../../src/commands/remote.js';
import type { GlobalConfig } from '@spatula/core';

// --- Mocks ---

let mockConfig: GlobalConfig | null = null;
const mockSaveGlobalConfig = vi.fn();

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => mockConfig),
    saveGlobalConfig: mockSaveGlobalConfig,
  };
});

// Mock fetch for health + subscription checks
function mockFetchSequence(responses: Array<{ ok: boolean; data?: unknown; status?: number }>): void {
  const mockFn = vi.fn();
  for (const r of responses) {
    mockFn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: () =>
        Promise.resolve(
          r.ok ? (r.data ?? { status: 'ok' }) : { error: { message: 'fail' } },
        ),
    });
  }
  vi.stubGlobal('fetch', mockFn);
}

describe('runRemoteAdd', () => {
  beforeEach(() => {
    mockConfig = { version: 1 };
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves remote config after verifying health and auth', async () => {
    mockFetchSequence([
      { ok: true, data: { status: 'ok' } },               // GET /health
      { ok: true, data: { plan: 'starter', usage: {} } },  // GET /api/v1/billing/subscription
    ]);

    const result = await runRemoteAdd({
      name: 'prod',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_live_abc',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('starter');
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(savedConfig.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(savedConfig.remotes?.prod?.apiKey).toBe('sk_live_abc');
  });

  it('returns error when health check fails', async () => {
    mockFetchSequence([{ ok: false, status: 500 }]);

    const result = await runRemoteAdd({
      name: 'bad',
      url: 'https://bad.example.com',
      apiKey: 'sk_bad',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('health');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns error when auth check fails', async () => {
    mockFetchSequence([
      { ok: true, data: { status: 'ok' } },  // health OK
      { ok: false, status: 401 },             // subscription 401
    ]);

    const result = await runRemoteAdd({
      name: 'noauth',
      url: 'https://api.spatula.dev',
      apiKey: 'sk_invalid',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('auth');
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement remote add**

```typescript
// apps/cli/src/commands/remote.ts
import { loadGlobalConfig, saveGlobalConfig } from '@spatula/core';
import type { GlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteAddInput {
  name: string;
  url: string;
  apiKey: string;
}

export interface RemoteAddResult {
  success: boolean;
  plan?: string;
  error?: string;
}

export interface RemoteEntry {
  name: string;
  url: string;
  hasApiKey: boolean;
}

export interface RemoteListResult {
  remotes: RemoteEntry[];
}

export interface RemoteRemoveResult {
  success: boolean;
  error?: string;
}

export interface RemoteJobControlResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRemoteConfig(name: string): { url: string; apiKey: string } | null {
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[name];
  if (!remote?.url || !remote?.apiKey) return null;
  return { url: remote.url, apiKey: remote.apiKey };
}

function createRemoteClient(name: string): { client: SpatulaApiClient; url: string } {
  const remote = getRemoteConfig(name);
  if (!remote) {
    throw new Error(
      `Remote "${name}" not found or missing API key. Run \`spatula remote add\` first.`,
    );
  }
  // tenantId is resolved server-side from the API key's JWT — pass empty string
  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });
  return { client, url: remote.url };
}

// ---------------------------------------------------------------------------
// remote add
// ---------------------------------------------------------------------------

export async function runRemoteAdd(input: RemoteAddInput): Promise<RemoteAddResult> {
  const { name, url, apiKey } = input;

  // 1. Verify health
  const client = new SpatulaApiClient(url, '', { apiKey });
  try {
    await client.getHealth();
  } catch {
    return { success: false, error: `Server health check failed for ${url}` };
  }

  // 2. Verify auth
  let plan: string | undefined;
  try {
    const sub = await client.getSubscription();
    plan = sub.plan as string | undefined;
  } catch {
    return { success: false, error: `Authentication failed — check your API key (auth verification failed)` };
  }

  // 3. Save to global config
  const existing = loadGlobalConfig() ?? { version: 1 };
  const updated: GlobalConfig = {
    ...existing,
    remotes: {
      ...existing.remotes,
      [name]: { url, apiKey },
    },
  };
  saveGlobalConfig(updated);

  return { success: true, plan };
}

// ---------------------------------------------------------------------------
// remote list
// ---------------------------------------------------------------------------

export interface RemoteListEntry extends RemoteEntry {
  jobId?: string;
  jobStatus?: string;
}

export interface RemoteListFullResult {
  remotes: RemoteListEntry[];
}

/**
 * List all configured remotes. When metaGet is provided (i.e., we're inside
 * a project directory), also fetch live job status for linked remotes.
 */
export async function runRemoteList(
  metaGet?: (key: string) => Promise<string | null>,
): Promise<RemoteListFullResult> {
  const config = loadGlobalConfig();
  const remotes = config?.remotes ?? {};

  const entries: RemoteListEntry[] = [];
  for (const [name, r] of Object.entries(remotes)) {
    const entry: RemoteListEntry = { name, url: r.url, hasApiKey: !!r.apiKey };

    // If we have project context, check for linked job and fetch live status
    if (metaGet && r.apiKey) {
      const jobId = await metaGet(`remote:${name}:job_id`);
      if (jobId) {
        entry.jobId = jobId;
        try {
          const client = new SpatulaApiClient(r.url, '', { apiKey: r.apiKey });
          const job = await client.getJob(jobId);
          entry.jobStatus = job.status as string;
        } catch {
          entry.jobStatus = 'unreachable';
        }
      }
    }

    entries.push(entry);
  }

  return { remotes: entries };
}

// ---------------------------------------------------------------------------
// remote remove
// ---------------------------------------------------------------------------

/**
 * Remove a remote config. When metaDeleteByPrefix is provided, also cleans up
 * project_meta entries (remote:<name>:*) for linked jobs.
 */
export async function runRemoteRemove(
  name: string,
  metaDeleteByPrefix?: (prefix: string) => Promise<void>,
): Promise<RemoteRemoveResult> {
  const config = loadGlobalConfig();
  if (!config?.remotes?.[name]) {
    return { success: false, error: `Remote "${name}" not found` };
  }

  // Remove from global config
  const { [name]: _removed, ...rest } = config.remotes;
  const updated: GlobalConfig = {
    ...config,
    remotes: Object.keys(rest).length > 0 ? rest : undefined,
  };
  saveGlobalConfig(updated);

  // Clean up project_meta entries if we have DB access
  if (metaDeleteByPrefix) {
    await metaDeleteByPrefix(`remote:${name}:`);
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// remote status
// ---------------------------------------------------------------------------

export async function runRemoteStatus(
  name: string,
  metaGet: (key: string) => Promise<string | null>,
): Promise<RemoteJobControlResult> {
  const { client } = createRemoteClient(name);
  const jobId = await metaGet(`remote:${name}:job_id`);
  if (!jobId) {
    return { success: false, error: `No linked job for remote "${name}". Run \`spatula push\` first.` };
  }
  try {
    const job = await client.getJob(jobId);
    return { success: true, data: job as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// remote pause / resume / cancel
// ---------------------------------------------------------------------------

export async function runRemoteJobAction(
  name: string,
  action: 'pause' | 'resume' | 'cancel',
  metaGet: (key: string) => Promise<string | null>,
): Promise<RemoteJobControlResult> {
  const { client } = createRemoteClient(name);
  const jobId = await metaGet(`remote:${name}:job_id`);
  if (!jobId) {
    return { success: false, error: `No linked job for remote "${name}". Run \`spatula push\` first.` };
  }
  try {
    const methods = {
      pause: () => client.pauseJob(jobId),
      resume: () => client.resumeJob(jobId),
      cancel: () => client.cancelJob(jobId),
    };
    const data = await methods[action]();
    return { success: true, data: data as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export { getRemoteConfig, createRemoteClient };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/remote.ts apps/cli/tests/unit/commands/remote.test.ts
git commit -m "feat(cli): add remote add/list/remove commands with auth verification"
```

---

## Task 5: Remote List / Remove Tests

**Files:**
- Test: `apps/cli/tests/unit/commands/remote.test.ts` (append)

- [ ] **Step 1: Append tests for list and remove**

Append to `apps/cli/tests/unit/commands/remote.test.ts`:

```typescript
describe('runRemoteList', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty array when no remotes configured', async () => {
    mockConfig = { version: 1 };
    const result = await runRemoteList();
    expect(result.remotes).toEqual([]);
  });

  it('lists all configured remotes without project context', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
        staging: { url: 'https://staging.spatula.dev' },
      },
    };
    const result = await runRemoteList();
    expect(result.remotes).toHaveLength(2);
    expect(result.remotes[0]).toMatchObject({ name: 'prod', url: 'https://api.spatula.dev', hasApiKey: true });
    expect(result.remotes[1]).toMatchObject({ name: 'staging', url: 'https://staging.spatula.dev', hasApiKey: false });
  });

  it('includes live job status when metaGet is provided', async () => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
    mockFetchSequence([{ ok: true, data: { id: 'job-1', status: 'running' } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');

    const result = await runRemoteList(metaGet);
    expect(result.remotes[0].jobId).toBe('job-1');
    expect(result.remotes[0].jobStatus).toBe('running');
  });
});

describe('runRemoteRemove', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' },
      },
    };
    mockSaveGlobalConfig.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('removes an existing remote from global config', async () => {
    const result = await runRemoteRemove('prod');
    expect(result.success).toBe(true);
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
    const saved = mockSaveGlobalConfig.mock.calls[0][0] as GlobalConfig;
    expect(saved.remotes).toBeUndefined();
  });

  it('cleans up project_meta when metaDeleteByPrefix is provided', async () => {
    const mockDeleteByPrefix = vi.fn().mockResolvedValue(undefined);
    const result = await runRemoteRemove('prod', mockDeleteByPrefix);
    expect(result.success).toBe(true);
    expect(mockDeleteByPrefix).toHaveBeenCalledWith('remote:prod:');
  });

  it('returns error for non-existent remote', async () => {
    const result = await runRemoteRemove('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/unit/commands/remote.test.ts
git commit -m "test(cli): add remote list/remove command tests"
```

---

## Task 6: Remote Status / Pause / Resume / Cancel Tests

**Files:**
- Test: `apps/cli/tests/unit/commands/remote.test.ts` (append)

- [ ] **Step 1: Append tests for job control commands**

Append to `apps/cli/tests/unit/commands/remote.test.ts`:

```typescript
describe('runRemoteStatus', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns job data for linked remote', async () => {
    mockFetchSequence([{ ok: true, data: { id: 'job-1', status: 'running' } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteStatus('prod', metaGet);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'job-1', status: 'running' });
    expect(metaGet).toHaveBeenCalledWith('remote:prod:job_id');
  });

  it('returns error when no linked job', async () => {
    const metaGet = vi.fn().mockResolvedValue(null);
    const result = await runRemoteStatus('prod', metaGet);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No linked job');
  });
});

describe('runRemoteJobAction', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('pauses a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { id: 'job-1', status: 'paused' } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'pause', metaGet);
    expect(result.success).toBe(true);
  });

  it('resumes a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { id: 'job-1', status: 'running' } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'resume', metaGet);
    expect(result.success).toBe(true);
  });

  it('cancels a remote job', async () => {
    mockFetchSequence([{ ok: true, data: { id: 'job-1', status: 'cancelled' } }]);
    const metaGet = vi.fn().mockResolvedValue('job-1');
    const result = await runRemoteJobAction('prod', 'cancel', metaGet);
    expect(result.success).toBe(true);
  });

  it('returns error when remote not configured', async () => {
    mockConfig = { version: 1 };
    const metaGet = vi.fn().mockResolvedValue('job-1');
    await expect(runRemoteJobAction('missing', 'pause', metaGet))
      .rejects.toThrow('not found');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/unit/commands/remote.test.ts
git commit -m "test(cli): add remote status/pause/resume/cancel tests"
```

---

## Task 7: Push Command

**Files:**
- Create: `apps/cli/src/commands/push.ts`
- Test: `apps/cli/tests/unit/commands/push.test.ts`

- [ ] **Step 1: Write failing tests for push**

```typescript
// apps/cli/tests/unit/commands/push.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPushCommand } from '../../../src/commands/push.js';
import type { GlobalConfig } from '@spatula/core';

// --- Mocks ---

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => ({
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
      },
    } as GlobalConfig)),
    parseProjectYamlFile: vi.fn(() => ({
      name: 'test-crawl',
      seeds: ['https://example.com'],
      depth: 2,
      limit: 100,
    })),
    yamlToJobConfig: vi.fn(() => ({
      tenantId: 'tenant-1',
      name: 'test-crawl',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    })),
    findProjectRoot: vi.fn(() => '/tmp/test-project'),
  };
});

const mockMetaGet = vi.fn();
const mockMetaSet = vi.fn();

function mockFetchOk(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    }),
  );
}

describe('runPushCommand', () => {
  beforeEach(() => {
    mockMetaGet.mockReset();
    mockMetaSet.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a job on the remote server and stores link in meta', async () => {
    mockMetaGet.mockResolvedValue(null); // no existing linked job
    mockFetchOk({ id: 'remote-job-123', status: 'pending' });

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('remote-job-123');
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:job_id', 'remote-job-123');
    expect(mockMetaSet).toHaveBeenCalledWith(
      'remote:prod:pushed_at',
      expect.any(String),
    );
  });

  it('returns existing job conflict when linked job is still running', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-999';
      return null;
    });

    // First call = getJob (check existing), returns running
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'old-job-999', status: 'running' } }),
      }),
    );

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.existingJobId).toBe('old-job-999');
    expect(result.existingJobStatus).toBe('running');
  });

  it('proceeds when existing linked job is completed', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-done';
      return null;
    });

    // First call = getJob (check existing, completed), second = createJob
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { id: 'old-job-done', status: 'completed' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { id: 'new-job-456', status: 'pending' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('new-job-456');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && npx vitest run tests/unit/commands/push.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement push command**

```typescript
// apps/cli/src/commands/push.ts
import { createHash } from 'node:crypto';
import {
  loadGlobalConfig,
  parseProjectYamlFile,
  yamlToJobConfig,
  findProjectRoot,
} from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushInput {
  remoteName: string;
  projectRoot: string;
  metaGet: (key: string) => Promise<string | null>;
  metaSet: (key: string, value: string) => Promise<void>;
  autoStart?: boolean;
  forceNew?: boolean;
}

export interface PushResult {
  success: boolean;
  jobId?: string;
  started?: boolean;
  conflict?: boolean;
  existingJobId?: string;
  existingJobStatus?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function runPushCommand(input: PushInput): Promise<PushResult> {
  const {
    remoteName,
    projectRoot,
    metaGet,
    metaSet,
    autoStart = false,
    forceNew = false,
  } = input;

  // 1. Resolve remote config
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[remoteName];
  if (!remote?.url || !remote?.apiKey) {
    return {
      success: false,
      error: `Remote "${remoteName}" not found or missing API key. Run \`spatula remote add\` first.`,
    };
  }

  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });

  // 2. Check for existing linked job
  if (!forceNew) {
    const existingJobId = await metaGet(`remote:${remoteName}:job_id`);
    if (existingJobId) {
      try {
        const existingJob = await client.getJob(existingJobId);
        const status = existingJob.status as string;
        const activeStatuses = ['pending', 'running', 'paused', 'reconciling'];
        if (activeStatuses.includes(status)) {
          return {
            success: false,
            conflict: true,
            existingJobId,
            existingJobStatus: status,
            error: `Existing job ${existingJobId} is ${status}. Cancel it first or use --force.`,
          };
        }
        // Completed/failed/cancelled — proceed with new job
      } catch {
        // Job not found on server — proceed with new job
      }
    }
  }

  // 3. Transform spatula.yaml → JobConfig
  const yaml = parseProjectYamlFile(projectRoot);
  const jobConfig = yamlToJobConfig(yaml, {
    tenantId: '', // Server assigns tenant from API key
    projectRoot,
  });

  // 4. Create job on remote
  let jobId: string;
  try {
    const created = await client.createJob(jobConfig as unknown as Record<string, unknown>);
    jobId = (created as Record<string, unknown>).id as string;
  } catch (err) {
    return { success: false, error: `Failed to create remote job: ${(err as Error).message}` };
  }

  // 5. Store link in project_meta
  const configHash = createHash('sha256')
    .update(JSON.stringify(jobConfig))
    .digest('hex')
    .slice(0, 12);

  await metaSet(`remote:${remoteName}:job_id`, jobId);
  await metaSet(`remote:${remoteName}:pushed_at`, new Date().toISOString());
  await metaSet(`remote:${remoteName}:config_hash`, configHash);

  // 6. Optionally start the job
  let started = false;
  if (autoStart) {
    try {
      await client.startJob(jobId);
      started = true;
    } catch {
      // Job created but failed to start — not a push failure
    }
  }

  return { success: true, jobId, started };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/push.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/push.ts apps/cli/tests/unit/commands/push.test.ts
git commit -m "feat(cli): add push command — creates remote jobs from local config"
```

---

## Task 8: ApiDataSource

**Files:**
- Create: `apps/cli/src/data-sources/api-data-source.ts`
- Test: `apps/cli/tests/unit/data-sources/api-data-source.test.ts`

- [ ] **Step 1: Write failing tests for ApiDataSource**

```typescript
// apps/cli/tests/unit/data-sources/api-data-source.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiDataSource } from '../../../src/data-sources/api-data-source.js';
import { SpatulaApiClient } from '../../../src/api/client.js';

function mockFetchOk(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    }),
  );
}

function mockFetchPaginated(data: unknown[], total: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data, total }),
    }),
  );
}

describe('ApiDataSource', () => {
  let client: SpatulaApiClient;
  let ds: ApiDataSource;

  beforeEach(() => {
    client = new SpatulaApiClient('http://localhost:3000', 'tenant-1', {
      apiKey: 'sk_test',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('getEntities calls listEntitiesPaginated and returns PaginatedResult', async () => {
    const entities = [{ id: 'e1', name: 'Test' }];
    mockFetchPaginated(entities, 1);
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getEntities({ limit: 10, offset: 0 });
    expect(result.data).toEqual(entities);
    expect(result.total).toBe(1);
  });

  it('getEntity calls client.getEntity', async () => {
    mockFetchOk({ id: 'e1', name: 'Entity 1' });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getEntity('e1');
    expect(result).toEqual({ id: 'e1', name: 'Entity 1' });
  });

  it('getSchema calls client.getSchema', async () => {
    mockFetchOk({ version: 3, fields: [] });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.getSchema();
    expect(result).toEqual({ version: 3, fields: [] });
  });

  it('getStatus calls client.getJob and transforms to ProjectStatus', async () => {
    mockFetchOk({
      id: 'job-1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      pagesDiscovered: 100,
      pagesCompleted: 42,
      entitiesExtracted: 20,
    });
    ds = new ApiDataSource(client, 'job-1');
    const status = await ds.getStatus();
    expect(status.totalPages).toBe(100);
    expect(status.totalEntities).toBe(20);
    expect(status.lastRun?.status).toBe('running');
  });

  it('approveAction calls client.approveAction', async () => {
    mockFetchOk({});
    ds = new ApiDataSource(client, 'job-1');
    await ds.approveAction('action-1', 'user-1');
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/actions/action-1/approve');
  });

  it('createExport calls client.createExport', async () => {
    mockFetchOk({ id: 'exp-1', format: 'json', status: 'pending' });
    ds = new ApiDataSource(client, 'job-1');
    const result = await ds.createExport({ format: 'json' });
    expect(result).toEqual({ id: 'exp-1', format: 'json', status: 'pending' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && npx vitest run tests/unit/data-sources/api-data-source.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ApiDataSource**

```typescript
// apps/cli/src/data-sources/api-data-source.ts
import type {
  DataSource,
  PaginationQuery,
  PaginatedResult,
  ProjectStatus,
  DataEvent,
} from '@spatula/core';
import type { Entity } from '@spatula/shared';
import type { SpatulaApiClient } from '../api/client.js';

/**
 * DataSource implementation backed by the Spatula REST API.
 * Used by `remote watch` (dashboard), pull flow, and any remote data access.
 */
export class ApiDataSource implements DataSource {
  constructor(
    private readonly client: SpatulaApiClient,
    private readonly jobId: string,
  ) {}

  async getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>> {
    const result = await this.client.listEntitiesPaginated(this.jobId, {
      limit: query.limit,
      offset: query.offset,
      search: query.search,
    });
    return { data: result.data as unknown as Entity[], total: result.total };
  }

  async getEntity(id: string): Promise<Entity | null> {
    try {
      const entity = await this.client.getEntity(this.jobId, id);
      return entity as unknown as Entity;
    } catch {
      return null;
    }
  }

  async searchEntities(filter: string): Promise<Entity[]> {
    const result = await this.client.listEntitiesPaginated(this.jobId, {
      search: filter,
      limit: 50,
    });
    return result.data as unknown as Entity[];
  }

  async getSchema(): Promise<unknown> {
    return this.client.getSchema(this.jobId);
  }

  async getSchemaVersions(): Promise<unknown[]> {
    return this.client.listSchemaVersions(this.jobId);
  }

  async getActions(status?: string): Promise<unknown[]> {
    return this.client.listActions(this.jobId, status ? { status } : undefined);
  }

  async approveAction(id: string, reviewedBy?: string): Promise<void> {
    await this.client.approveAction(this.jobId, id, reviewedBy);
  }

  async rejectAction(id: string, reviewedBy?: string): Promise<void> {
    await this.client.rejectAction(this.jobId, id, reviewedBy);
  }

  async getStatus(): Promise<ProjectStatus> {
    const job = await this.client.getJob(this.jobId);
    return {
      lastRun: {
        id: job.id as string,
        status: job.status as string,
        startedAt: (job.startedAt as string) ?? '',
        pagesProcessed: (job.pagesCompleted as number) ?? 0,
        entitiesCreated: (job.entitiesExtracted as number) ?? 0,
      },
      totalPages: (job.pagesDiscovered as number) ?? 0,
      totalEntities: (job.entitiesExtracted as number) ?? 0,
      pendingActions: 0, // Not available from job endpoint
      schemaFields: 0,   // Not available from job endpoint
      storageBytes: { pages: 0, database: 0, exports: 0 },
    };
  }

  async createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown> {
    return this.client.createExport(this.jobId, options);
  }

  async getExport(id: string): Promise<unknown> {
    return this.client.getExport(this.jobId, id);
  }

  async downloadExport(id: string): Promise<string> {
    return this.client.downloadExport(this.jobId, id);
  }

  async getDocumentation(): Promise<unknown> {
    return this.client.getDocumentation(this.jobId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/data-sources/api-data-source.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/data-sources/api-data-source.ts apps/cli/tests/unit/data-sources/api-data-source.test.ts
git commit -m "feat(cli): add ApiDataSource implementing DataSource for remote access"
```

---

## Task 9: WebSocket Token Auth Support

**Files:**
- Modify: `apps/cli/src/hooks/useWebSocket.ts`
- Test: `apps/cli/tests/unit/commands/remote-watch.test.ts`

- [ ] **Step 1: Write failing test for token-based WS URL**

```typescript
// apps/cli/tests/unit/commands/remote-watch.test.ts
import { describe, it, expect } from 'vitest';
import { buildWsUrl } from '../../../src/hooks/useWebSocket.js';

describe('buildWsUrl', () => {
  it('builds local WS URL with tenantId query param', () => {
    const url = buildWsUrl('http://localhost:3000', 'tenant-1', 'job-1');
    expect(url).toBe('ws://localhost:3000/ws/jobs/job-1/progress?tenantId=tenant-1');
  });

  it('builds authenticated WS URL with token query param', () => {
    const url = buildWsUrl('https://api.spatula.dev', 'tenant-1', 'job-1', 'tok_abc');
    expect(url).toBe('wss://api.spatula.dev/ws/jobs/job-1/progress?token=tok_abc');
  });

  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.example.com', '', 'j1', 'tok');
    expect(url).toMatch(/^wss:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote-watch.test.ts`
Expected: FAIL — `buildWsUrl` not exported

- [ ] **Step 3: Extract and export buildWsUrl, add token support to useWebSocket**

In `apps/cli/src/hooks/useWebSocket.ts`, extract the URL construction into a named exported function and update `useWebSocket` to accept an optional `token` parameter:

Replace the `useWebSocket` function and add `buildWsUrl` before it:

```typescript
// Add this exported function BEFORE the useWebSocket function:

/**
 * Build the WebSocket URL for job progress.
 * When a token is provided, it's used for authentication (remote mode).
 * Otherwise, tenantId is passed as a query param (local mode).
 */
export function buildWsUrl(
  baseUrl: string,
  tenantId: string,
  jobId: string,
  token?: string,
): string {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const authParam = token ? `token=${token}` : `tenantId=${tenantId}`;
  return `${wsBase}/ws/jobs/${jobId}/progress?${authParam}`;
}
```

Then update the `useWebSocket` signature and the URL construction inside the `useEffect`:

```typescript
export function useWebSocket(
  store: CliStore,
  baseUrl: string,
  tenantId: string,
  jobId: string,
  token?: string,
): UseWebSocketResult {
  // ... existing state and refs ...

  useEffect(() => {
    // ... existing setup ...

    if (!jobId) return;
    if (!baseUrl) return;

    const wsUrl = buildWsUrl(baseUrl, tenantId, jobId, token);

    // ... rest of connect() and cleanup unchanged ...
  }, [store, baseUrl, tenantId, jobId, token]);  // Add token to deps

  return { connected, error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote-watch.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing WebSocket tests for regression**

Run: `cd apps/cli && npx vitest run tests/unit/ -t "useWebSocket\|WebSocket\|parseWSMessage\|applyWSMessage"`
Expected: All PASS (token param is optional)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/hooks/useWebSocket.ts apps/cli/tests/unit/commands/remote-watch.test.ts
git commit -m "feat(cli): add token-based WS auth for remote watch connections"
```

---

## Task 10: Remote Watch Command (Ink TUI) + DashboardView wsToken Support

**Files:**
- Modify: `apps/cli/src/components/dashboard/DashboardView.tsx`
- Create: `apps/cli/src/commands/remote-watch.tsx`
- Test: `apps/cli/tests/unit/commands/remote-watch.test.ts` (append)

- [ ] **Step 1: Add optional `wsToken` prop to DashboardView**

In `apps/cli/src/components/dashboard/DashboardView.tsx`, update the props interface and the `useWebSocket` call:

```typescript
// Update the interface:
export interface DashboardViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
  wsToken?: string;  // For remote watch: token-based WS auth
}

// Update the function signature:
export function DashboardView({
  store,
  backend,
  wsToken,
}: DashboardViewProps): React.ReactElement {
```

Then update the `useWebSocket` call to pass the token:

```typescript
  const { connected: wsConnected } = useWebSocket(
    store,
    wsBaseUrl,
    wsTenantId,
    activeJobId ?? '',
    wsToken,
  );
```

- [ ] **Step 2: Append test for getRemoteWatchConfig helper**

Append to `apps/cli/tests/unit/commands/remote-watch.test.ts`:

```typescript
import { vi, afterEach, beforeEach } from 'vitest';
import { getRemoteWatchConfig } from '../../../src/commands/remote-watch.js';
import type { GlobalConfig } from '@spatula/core';

let mockConfig: GlobalConfig | null;
vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => mockConfig),
  };
});

describe('getRemoteWatchConfig', () => {
  beforeEach(() => {
    mockConfig = {
      version: 1,
      remotes: { prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live' } },
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns remote URL, API key, and job ID', async () => {
    const metaGet = vi.fn().mockResolvedValue('job-abc');
    const config = await getRemoteWatchConfig('prod', metaGet);
    expect(config).toEqual({
      baseUrl: 'https://api.spatula.dev',
      apiKey: 'sk_live',
      jobId: 'job-abc',
    });
  });

  it('throws when no linked job', async () => {
    const metaGet = vi.fn().mockResolvedValue(null);
    await expect(getRemoteWatchConfig('prod', metaGet)).rejects.toThrow('No linked job');
  });

  it('throws when remote not configured', async () => {
    mockConfig = { version: 1 };
    const metaGet = vi.fn().mockResolvedValue('job-1');
    await expect(getRemoteWatchConfig('missing', metaGet)).rejects.toThrow('not found');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote-watch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement remote watch**

```tsx
// apps/cli/src/commands/remote-watch.tsx
import React from 'react';
import { render } from 'ink';
import { loadGlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface RemoteWatchConfig {
  baseUrl: string;
  apiKey: string;
  jobId: string;
}

export async function getRemoteWatchConfig(
  remoteName: string,
  metaGet: (key: string) => Promise<string | null>,
): Promise<RemoteWatchConfig> {
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[remoteName];
  if (!remote?.url || !remote?.apiKey) {
    throw new Error(
      `Remote "${remoteName}" not found or missing API key. Run \`spatula remote add\` first.`,
    );
  }

  const jobId = await metaGet(`remote:${remoteName}:job_id`);
  if (!jobId) {
    throw new Error(
      `No linked job for remote "${remoteName}". Run \`spatula push\` first.`,
    );
  }

  return { baseUrl: remote.url, apiKey: remote.apiKey, jobId };
}

// ---------------------------------------------------------------------------
// Watch runner (called from CLI index.tsx)
// ---------------------------------------------------------------------------

export async function runRemoteWatchCommand(
  remoteName: string,
  metaGet: (key: string) => Promise<string | null>,
): Promise<void> {
  const { baseUrl, apiKey, jobId } = await getRemoteWatchConfig(remoteName, metaGet);
  const client = new SpatulaApiClient(baseUrl, '', { apiKey });

  // 1. Obtain WS auth token
  const { token } = await client.getWsToken();

  // 2. Dynamic import to avoid loading Ink/React in non-TUI commands
  const { DashboardView } = await import('../components/dashboard/index.js');
  const { createCliStore } = await import('../store/index.js');

  // createCliStore requires a tenantId — use 'remote' as placeholder since
  // the server resolves tenant from the API key, not from the client store.
  const store = createCliStore('remote');

  // 3. Set initial state: activeJobId so DashboardView starts polling
  store.getState().setActiveJobId(jobId);

  // 4. Render dashboard with the API client as backend + WS token for auth
  // DashboardView accepts `DataSource | SpatulaApiClient` as backend.
  // Passing the client directly enables: WS URL from client.baseUrl,
  // keybindings for pause/resume/cancel via client methods.
  const { waitUntilExit } = render(
    <DashboardView store={store} backend={client} wsToken={token} />,
  );

  await waitUntilExit();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/remote-watch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/remote-watch.tsx apps/cli/tests/unit/commands/remote-watch.test.ts
git commit -m "feat(cli): add remote watch command with WS token auth and dashboard TUI"
```

---

## Task 11: Expose metaRepo on LocalProject + CLI Command Registration

**Files:**
- Modify: `apps/cli/src/local-project.ts`
- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Extend LocalProject to expose metaRepo**

In `apps/cli/src/local-project.ts`, add `metaRepo` to the `LocalProject` interface and the return object:

```typescript
import type { ProjectMetaRepository } from '@spatula/db';

export interface LocalProject {
  dataSource: DataSource;
  projectRoot: string;
  projectId: string;
  metaRepo: ProjectMetaRepository;
  close(): void;
}
```

Then in `openLocalProject`, add `metaRepo` to the return:

```typescript
  return {
    dataSource,
    projectRoot,
    projectId,
    metaRepo: adapter.metaRepo,
    close: () => dbResult.close(),
  };
```

- [ ] **Step 2: Add remote and push commands to CLI**

In `apps/cli/src/index.tsx`, add the imports at the top of the file:

```typescript
import { runRemoteAdd, runRemoteList, runRemoteRemove, runRemoteStatus, runRemoteJobAction } from './commands/remote.js';
```

Then add the `remote` command block before `.demandCommand(1, ...)`:

```typescript
  // -------------------------------------------------------------------------
  // remote — manage remote server connections
  // -------------------------------------------------------------------------
  .command(
    'remote <action> [name]',
    'Manage remote Spatula server connections',
    (y) =>
      y
        .positional('action', {
          type: 'string',
          choices: ['add', 'list', 'remove', 'status', 'pause', 'resume', 'cancel', 'watch'] as const,
          demandOption: true,
          describe: 'Remote action to perform',
        })
        .positional('name', {
          type: 'string',
          describe: 'Remote name (required for all except list)',
        })
        .option('url', {
          type: 'string',
          describe: 'Server URL (for add)',
        })
        .option('key', {
          type: 'string',
          describe: 'API key (for add)',
        }),
    async (argv) => {
      const action = argv.action as string;
      const name = argv.name as string | undefined;

      if (action === 'list') {
        // Try to open project for live job status; gracefully degrade without project
        let metaGet: ((key: string) => Promise<string | null>) | undefined;
        let closeProject: (() => void) | undefined;
        try {
          const { openLocalProject } = await import('./local-project.js');
          const project = await openLocalProject(process.cwd());
          metaGet = (key) => project.metaRepo.get(key);
          closeProject = () => project.close();
        } catch { /* Not in a project directory — list without job status */ }

        try {
          const result = await runRemoteList(metaGet);
          if (result.remotes.length === 0) {
            console.log('  No remotes configured. Run `spatula remote add <name>` to add one.');
            return;
          }
          console.log('\n  Configured remotes:\n');
          for (const r of result.remotes) {
            const keyStatus = r.hasApiKey ? '(authenticated)' : '(no key)';
            const jobInfo = r.jobId ? ` → job ${r.jobId.slice(0, 8)} (${r.jobStatus})` : '';
            console.log(`    ${r.name}  ${r.url}  ${keyStatus}${jobInfo}`);
          }
          console.log('');
        } finally {
          closeProject?.();
        }
        return;
      }

      if (!name) {
        console.error('Error: remote name is required for this action.');
        process.exit(1);
      }

      if (action === 'add') {
        const url = argv.url;
        const apiKey = argv.key;
        if (!url || !apiKey) {
          console.error('Error: --url and --key are required for `remote add`.');
          process.exit(1);
        }
        const result = await runRemoteAdd({ name, url, apiKey });
        if (result.success) {
          console.log(`\n  Remote "${name}" added (plan: ${result.plan ?? 'unknown'}).`);
        } else {
          console.error(`\n  Error: ${result.error}`);
          process.exit(1);
        }
        return;
      }

      if (action === 'remove') {
        // Try to get project context for meta cleanup
        let metaDeleteByPrefix: ((prefix: string) => Promise<void>) | undefined;
        let closeProject: (() => void) | undefined;
        try {
          const { openLocalProject } = await import('./local-project.js');
          const project = await openLocalProject(process.cwd());
          metaDeleteByPrefix = (prefix) => project.metaRepo.deleteByPrefix(prefix);
          closeProject = () => project.close();
        } catch { /* Not in a project directory — remove config only */ }

        try {
          const result = await runRemoteRemove(name, metaDeleteByPrefix);
          if (result.success) {
            console.log(`\n  Remote "${name}" removed.`);
          } else {
            console.error(`\n  Error: ${result.error}`);
            process.exit(1);
          }
        } finally {
          closeProject?.();
        }
        return;
      }

      // Actions that need project context (status, pause, resume, cancel, watch)
      const { openLocalProject } = await import('./local-project.js');
      let project;
      try {
        project = await openLocalProject(process.cwd());
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
        return;
      }

      try {
        const metaGet = (key: string) => project.metaRepo.get(key);

        if (action === 'status') {
          const result = await runRemoteStatus(name, metaGet);
          if (result.success && result.data) {
            const d = result.data;
            console.log(`\n  Job: ${d.id}`);
            console.log(`  Status: ${d.status}`);
            if (d.pagesCompleted !== undefined) console.log(`  Pages: ${d.pagesCompleted}/${d.pagesDiscovered ?? '?'}`);
            if (d.entitiesExtracted !== undefined) console.log(`  Entities: ${d.entitiesExtracted}`);
            console.log('');
          } else {
            console.error(`\n  Error: ${result.error}`);
            process.exit(1);
          }
        } else if (action === 'watch') {
          const { runRemoteWatchCommand } = await import('./commands/remote-watch.js');
          await runRemoteWatchCommand(name, metaGet);
        } else if (['pause', 'resume', 'cancel'].includes(action)) {
          const result = await runRemoteJobAction(
            name,
            action as 'pause' | 'resume' | 'cancel',
            metaGet,
          );
          if (result.success) {
            console.log(`\n  Job ${action}d successfully.`);
          } else {
            console.error(`\n  Error: ${result.error}`);
            process.exit(1);
          }
        }
      } finally {
        project.close();
      }
    },
  )

  // -------------------------------------------------------------------------
  // push — push config to remote server
  // -------------------------------------------------------------------------
  .command(
    'push [remote]',
    'Push project config to a remote Spatula server and create a job',
    (y) =>
      y
        .positional('remote', {
          type: 'string',
          default: 'default',
          describe: 'Remote name (from `spatula remote add`)',
        })
        .option('start', {
          type: 'boolean',
          default: true,
          describe: 'Start crawling immediately after push',
        })
        .option('force', {
          type: 'boolean',
          default: false,
          describe: 'Create new job even if an active job exists',
        }),
    async (argv) => {
      const remoteName = argv.remote as string;

      const { openLocalProject } = await import('./local-project.js');
      const { runPushCommand } = await import('./commands/push.js');

      let project;
      try {
        project = await openLocalProject(process.cwd());
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
        return;
      }

      try {
        const result = await runPushCommand({
          remoteName,
          projectRoot: project.projectRoot,
          metaGet: (key) => project.metaRepo.get(key),
          metaSet: (key, value) => project.metaRepo.set(key, value),
          autoStart: argv.start,
          forceNew: argv.force,
        });

        if (result.success) {
          console.log(`\n  Job created: ${result.jobId}`);
          if (result.started) {
            console.log('  Crawling started. Use `spatula remote watch` to monitor progress.');
          } else {
            console.log('  Use `spatula remote status` to check, or pass --start to begin crawling.');
          }
          console.log('');
        } else if (result.conflict) {
          console.error(`\n  Conflict: existing job ${result.existingJobId} is ${result.existingJobStatus}.`);
          console.error('  Cancel it with `spatula remote cancel` or use `spatula push --force`.');
          process.exit(1);
        } else {
          console.error(`\n  Error: ${result.error}`);
          process.exit(1);
        }
      } finally {
        project.close();
      }
    },
  )
```

- [ ] **Step 2: Update CLI header comment to include new commands**

At the top of `apps/cli/src/index.tsx`, update the command list comment to include `remote` and `push`.

- [ ] **Step 3: Build to verify no TypeScript errors**

Run: `cd apps/cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(cli): register remote and push commands in CLI entrypoint"
```

---

## Task 12: ProjectMetaRepository delete method (for remote remove cleanup)

> **Ordering note:** This task MUST be completed before Task 11 (CLI registration), which wires `deleteByPrefix` into the `remote remove` handler. It can be executed any time after Task 3.

**Files:**
- Modify: `packages/db/src/project-db/repositories/project-meta-repository.ts`
- Test: existing project-meta tests (append)

- [ ] **Step 1: Write failing test for delete and deleteByPrefix**

Find or create the test file for project-meta-repository and append:

```typescript
// In the project-meta repository test file, add:

describe('ProjectMetaRepository.delete', () => {
  it('removes a single key', async () => {
    await repo.set('test-key', 'test-value');
    expect(await repo.get('test-key')).toBe('test-value');
    await repo.delete('test-key');
    expect(await repo.get('test-key')).toBeNull();
  });
});

describe('ProjectMetaRepository.deleteByPrefix', () => {
  it('removes all keys matching prefix', async () => {
    await repo.set('remote:prod:job_id', 'job-1');
    await repo.set('remote:prod:pushed_at', '2026-01-01');
    await repo.set('remote:staging:job_id', 'job-2');
    await repo.set('unrelated', 'keep');

    await repo.deleteByPrefix('remote:prod:');

    expect(await repo.get('remote:prod:job_id')).toBeNull();
    expect(await repo.get('remote:prod:pushed_at')).toBeNull();
    expect(await repo.get('remote:staging:job_id')).toBe('job-2');
    expect(await repo.get('unrelated')).toBe('keep');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && npx vitest run tests/ -t "delete"`
Expected: FAIL — methods do not exist

- [ ] **Step 3: Implement delete and deleteByPrefix**

In `packages/db/src/project-db/repositories/project-meta-repository.ts`, add after the `getAll` method:

```typescript
  async delete(key: string): Promise<void> {
    wrapStorageError(
      () => this.db.delete(projectMeta).where(eq(projectMeta.key, key)).run(),
      { operation: 'delete', table: 'project_meta', key },
    );
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    wrapStorageError(
      () =>
        this.db
          .delete(projectMeta)
          .where(like(projectMeta.key, `${prefix}%`))
          .run(),
      { operation: 'deleteByPrefix', table: 'project_meta', prefix },
    );
  }
```

Add `like` to the drizzle-orm imports at the top of the file:

```typescript
import { eq, like } from 'drizzle-orm';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/db && npx vitest run tests/ -t "delete"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/project-db/repositories/project-meta-repository.ts
git commit -m "feat(db): add delete and deleteByPrefix to ProjectMetaRepository"
```

---

## Task 13: Full Integration Test — Push Flow

**Files:**
- Test: `apps/cli/tests/unit/commands/push.test.ts` (append)

- [ ] **Step 1: Add auto-start test**

Append to `apps/cli/tests/unit/commands/push.test.ts`:

```typescript
describe('runPushCommand — auto-start', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts the job after creation when autoStart is true', async () => {
    mockMetaGet.mockResolvedValue(null);

    // First call = createJob, second call = startJob
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { id: 'job-auto', status: 'pending' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { id: 'job-auto', status: 'running' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: true,
    });

    expect(result.success).toBe(true);
    expect(result.started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should be POST to /start
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain('/start');
  });

  it('stores config hash in project_meta', async () => {
    mockMetaGet.mockResolvedValue(null);
    mockFetchOk({ id: 'job-hash', status: 'pending' });

    await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    const hashCall = mockMetaSet.mock.calls.find(
      (c: string[]) => c[0] === 'remote:prod:config_hash',
    );
    expect(hashCall).toBeDefined();
    expect(hashCall![1]).toMatch(/^[a-f0-9]{12}$/);
  });

  it('skips conflict check when forceNew is true', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'old-job-running';
      return null;
    });

    // Only one fetch call — createJob (no getJob check)
    mockFetchOk({ id: 'forced-job', status: 'pending' });

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
      forceNew: true,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('forced-job');
  });

  it('returns error when createJob fails', async () => {
    mockMetaGet.mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { message: 'Internal server error' } }),
      }),
    );

    const result = await runPushCommand({
      remoteName: 'prod',
      projectRoot: '/tmp/test-project',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      autoStart: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create remote job');
    expect(mockMetaSet).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/cli && npx vitest run tests/unit/commands/push.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/unit/commands/push.test.ts
git commit -m "test(cli): add push auto-start and config hash tests"
```

---

## Task 14: Full Test Suite Verification

- [ ] **Step 1: Run all CLI tests**

Run: `cd apps/cli && npx vitest run`
Expected: All PASS. No regressions from the optional `options` parameter on `SpatulaApiClient` constructor.

- [ ] **Step 2: Run core package tests**

Run: `cd packages/core && npx vitest run`
Expected: All PASS.

- [ ] **Step 3: Run db package tests**

Run: `cd packages/db && npx vitest run`
Expected: All PASS.

- [ ] **Step 4: Run TypeScript type check across monorepo**

Run: `npx turbo typecheck`
Expected: All packages pass.

- [ ] **Step 5: Commit any test fixups if needed**

If any adjustments were needed for existing tests (e.g., updating `SpatulaApiClient` constructor calls in mocks), commit them as:

```bash
git commit -m "fix: update existing tests for SpatulaApiClient optional options param"
```

---

## Summary

| Task | What | New/Modified Files |
|------|------|-------------------|
| 1 | API client auth headers | `client.ts`, `client-auth.test.ts` |
| 2 | API client new methods | `client.ts`, `client-auth.test.ts` |
| 3 | saveGlobalConfig utility | `global-config.ts`, `index.ts`, test |
| 4 | Remote add command | `remote.ts`, `remote.test.ts` |
| 5 | Remote list/remove tests | `remote.test.ts` |
| 6 | Remote status/control tests | `remote.test.ts` |
| 7 | Push command | `push.ts`, `push.test.ts` |
| 8 | ApiDataSource | `api-data-source.ts`, test |
| 9 | WS token auth | `useWebSocket.ts`, test |
| 10 | Remote watch + DashboardView wsToken | `DashboardView.tsx`, `remote-watch.tsx`, test |
| 11 | Expose metaRepo + CLI registration | `local-project.ts`, `index.tsx` |
| 12 | Meta delete methods (before Task 11) | `project-meta-repository.ts`, test |
| 13 | Push integration tests | `push.test.ts` |
| 14 | Full suite verification | — |

**Execution order:** 1→2→3→4→5→6→7→8→9→10→12→11→13→14 (Task 12 before Task 11)

**Estimated new test count:** ~40-45 new test cases across 5 new test files.

### Review Fixes Applied

These issues were caught by code review and fixed in this plan revision:

1. **[Critical]** `createCliStore()` → `createCliStore('remote')` — required `tenantId` arg
2. **[Critical]** `DashboardView` props: pass `SpatulaApiClient` as `backend` + added `wsToken` prop
3. **[Important]** `remote list`: now accepts optional `metaGet` for live job status from linked remotes
4. **[Important]** `remote remove`: now accepts optional `metaDeleteByPrefix` to clean up `project_meta`
5. **[Important]** Removed dead `metaGet` code and redundant DB open in CLI registration
6. **[Important]** Extended `LocalProject` to expose `metaRepo` — single DB connection, no double-open
7. **[Important]** Added tests for `forceNew: true` and `createJob` error path in push
8. **[Important]** Task 12 ordering note: must execute before Task 11
