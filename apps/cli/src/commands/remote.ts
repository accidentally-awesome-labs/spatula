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
  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });
  return { client, url: remote.url };
}

// ---------------------------------------------------------------------------
// remote add
// ---------------------------------------------------------------------------

export async function runRemoteAdd(input: RemoteAddInput): Promise<RemoteAddResult> {
  const { name, url, apiKey } = input;

  const client = new SpatulaApiClient(url, '', { apiKey });
  try {
    await client.getHealth();
  } catch {
    return { success: false, error: `Server health check failed for ${url}` };
  }

  let plan: string | undefined;
  try {
    const sub = await client.getSubscription();
    plan = sub.plan as string | undefined;
  } catch {
    return { success: false, error: `Authentication failed — check your API key (auth verification failed)` };
  }

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

export async function runRemoteList(
  metaGet?: (key: string) => Promise<string | null>,
): Promise<RemoteListFullResult> {
  const config = loadGlobalConfig();
  const remotes = config?.remotes ?? {};

  const entries: RemoteListEntry[] = [];
  for (const [name, r] of Object.entries(remotes)) {
    const entry: RemoteListEntry = { name, url: r.url, hasApiKey: !!r.apiKey };

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

export async function runRemoteRemove(
  name: string,
  metaDeleteByPrefix?: (prefix: string) => Promise<void>,
): Promise<RemoteRemoveResult> {
  const config = loadGlobalConfig();
  if (!config?.remotes?.[name]) {
    return { success: false, error: `Remote "${name}" not found` };
  }

  const { [name]: _removed, ...rest } = config.remotes;
  const updated: GlobalConfig = {
    ...config,
    remotes: Object.keys(rest).length > 0 ? rest : undefined,
  };
  saveGlobalConfig(updated);

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
