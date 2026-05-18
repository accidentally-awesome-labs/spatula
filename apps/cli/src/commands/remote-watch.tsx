import React from 'react';
import { render } from 'ink';
import { loadGlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';

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
    throw new Error(`No linked job for remote "${remoteName}". Run \`spatula push\` first.`);
  }

  return { baseUrl: remote.url, apiKey: remote.apiKey, jobId };
}

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
  const { waitUntilExit } = render(
    <DashboardView store={store} backend={client} wsToken={token} />,
  );

  await waitUntilExit();
}
