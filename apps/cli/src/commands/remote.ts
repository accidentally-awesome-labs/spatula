import { loadGlobalConfig, saveGlobalConfig } from '@accidentally-awesome-labs/spatula-core';
import type { GlobalConfig } from '@accidentally-awesome-labs/spatula-core';
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
  tenantId?: string;
  scopes?: string[];
  error?: string;
}

export interface RemoteEntry {
  name: string;
  url: string;
  hasApiKey: boolean;
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

  let tenantId: string | undefined;
  let scopes: string[] | undefined;
  try {
    const me = await client.getAuthMe();
    tenantId = me.tenantId;
    scopes = me.scopes;
  } catch {
    return {
      success: false,
      error: `Authentication failed — check your API key (auth verification failed)`,
    };
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

  return { success: true, tenantId, scopes };
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

  const { [name]: _removed, ...rest } = config.remotes; // eslint-disable-line @typescript-eslint/no-unused-vars
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
    return {
      success: false,
      error: `No linked job for remote "${name}". Run \`spatula push\` first.`,
    };
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
    return {
      success: false,
      error: `No linked job for remote "${name}". Run \`spatula push\` first.`,
    };
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

// ---------------------------------------------------------------------------
// CLI handler — orchestrates sub-actions with project lifecycle
// ---------------------------------------------------------------------------

export interface RemoteCommandArgs {
  action: string;
  name?: string;
  url?: string;
  key?: string;
}

export async function handleRemoteCommand(argv: RemoteCommandArgs): Promise<void> {
  const { action, name } = argv;

  if (action === 'list') {
    let metaGet: ((key: string) => Promise<string | null>) | undefined;
    let closeProject: (() => void) | undefined;
    try {
      const { openLocalProject } = await import('../local-project.js');
      const project = await openLocalProject(process.cwd());
      metaGet = (key) => project.metaRepo.get(key);
      closeProject = () => project.close();
    } catch {
      /* Not in a project directory */
    }

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
    const { url, key: apiKey } = argv;
    if (!url || !apiKey) {
      console.error('Error: --url and --key are required for `remote add`.');
      process.exit(1);
    }
    const result = await runRemoteAdd({ name, url, apiKey });
    if (result.success) {
      const tenantSuffix = result.tenantId ? ` (tenant: ${result.tenantId})` : '';
      console.log(`\n  Remote "${name}" added${tenantSuffix}.`);
    } else {
      console.error(`\n  Error: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  if (action === 'remove') {
    let metaDeleteByPrefix: ((prefix: string) => Promise<void>) | undefined;
    let closeProject: (() => void) | undefined;
    try {
      const { openLocalProject } = await import('../local-project.js');
      const project = await openLocalProject(process.cwd());
      metaDeleteByPrefix = (prefix) => project.metaRepo.deleteByPrefix(prefix);
      closeProject = () => project.close();
    } catch {
      /* Not in a project directory */
    }

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
  const { openLocalProject } = await import('../local-project.js');
  let project;
  try {
    project = await openLocalProject(process.cwd());
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  try {
    const metaGet = (key: string) => project.metaRepo.get(key);

    if (action === 'status') {
      const result = await runRemoteStatus(name, metaGet);
      if (result.success && result.data) {
        const d = result.data;
        console.log(`\n  Job: ${d.id}`);
        console.log(`  Status: ${d.status}`);
        if (d.pagesCompleted !== undefined)
          console.log(`  Pages: ${d.pagesCompleted}/${d.pagesDiscovered ?? '?'}`);
        if (d.entitiesExtracted !== undefined) console.log(`  Entities: ${d.entitiesExtracted}`);
        console.log('');
      } else {
        console.error(`\n  Error: ${result.error}`);
        process.exit(1);
      }
    } else if (action === 'watch') {
      const { runRemoteWatchCommand } = await import('./remote-watch.js');
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
}
