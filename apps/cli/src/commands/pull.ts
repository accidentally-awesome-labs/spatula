// apps/cli/src/commands/pull.ts
import { loadGlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';
import { createLogger } from '@spatula/shared';

const logger = createLogger('cli:pull');

export interface PullInput {
  remoteName: string;
  metaGet: (key: string) => Promise<string | null>;
  metaSet: (key: string, value: string) => Promise<void>;
  metaDelete: (key: string) => Promise<void>;
  adapter: {
    entityRepo: {
      upsertBatch: (batch: Array<{
        id: string;
        mergedData: Record<string, unknown>;
        provenance: Record<string, unknown>;
        qualityScore: number;
        categories: unknown[];
        runId: string | null;
      }>) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
    };
    schemaRepo: {
      findLatest: (jobId: string, tenantId?: string) => Promise<{ id: string; version: number; definition: unknown } | null>;
      create: (data: {
        jobId: string; tenantId: string; version: number;
        definition: unknown; parentId?: string;
      }) => Promise<unknown>;
    };
    runRepo: {
      create: (data: {
        status: string; source: string;
        configSnapshot: Record<string, unknown>; startedAt: string;
      }) => Promise<{ id: string }>;
      updateStats: (id: string, stats: Record<string, unknown>) => Promise<void>;
      findLatestByStatus?: (statuses: string[]) => Promise<{ id: string; source: string } | null>;
      findIdsBySourcePrefix: (prefix: string) => Promise<string[]>;
    };
  };
  projectId: string;
  projectRoot: string;
  full?: boolean;
  restart?: boolean;
  skipSchema?: boolean;
  onProgress?: (batch: number, total: number) => void;
  resolveSchemaConflict?: (diff: unknown) => Promise<'remote' | 'local' | 'merge'>;
  resolveRunningJob?: (status: string, stats?: Record<string, unknown>) => Promise<'snapshot' | 'wait' | 'cancel'>;
}

export interface PullResult {
  success: boolean;
  entitiesInserted?: number;
  entitiesUpdated?: number;
  schemaFieldsAdded?: number;
  llmTokens?: number;
  llmCostUsd?: number;
  resumed?: boolean;
  error?: string;
  jobStatus?: string;
}

function getRemoteConfig(name: string): { url: string; apiKey: string } | null {
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[name];
  if (!remote?.url || !remote?.apiKey) return null;
  return { url: remote.url, apiKey: remote.apiKey };
}

export async function runPullCommand(input: PullInput): Promise<PullResult> {
  // Step 1: Resolve remote
  const remote = getRemoteConfig(input.remoteName);
  if (!remote) {
    return { success: false, error: `Remote "${input.remoteName}" not found or missing API key. Run \`spatula remote add\` first.` };
  }

  const jobId = await input.metaGet(`remote:${input.remoteName}:job_id`);
  if (!jobId) {
    return { success: false, error: `No job linked for remote '${input.remoteName}'. Run \`spatula push\` first.` };
  }

  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });
  const startedAt = new Date().toISOString();

  // Step 2: Check job status
  let jobData: Record<string, unknown>;
  try {
    jobData = await client.getJob(jobId) as Record<string, unknown>;
  } catch (err) {
    return { success: false, error: `Failed to fetch job ${jobId}: ${(err as Error).message}` };
  }
  const jobStatus = jobData.status as string;

  if (jobStatus === 'running' || jobStatus === 'paused') {
    if (!input.resolveRunningJob) {
      return { success: false, jobStatus, error: `Job is still ${jobStatus}. Use interactive mode for snapshot/wait options.` };
    }
    const choice = await input.resolveRunningJob(jobStatus, jobData.stats as Record<string, unknown>);
    if (choice === 'cancel') {
      return { success: false, error: 'Pull cancelled by user.' };
    }
    if (choice === 'wait') {
      // Poll until completed
      let pollStatus = jobStatus;
      while (pollStatus === 'running' || pollStatus === 'paused') {
        await new Promise((r) => setTimeout(r, 30_000));
        const pollData = await client.getJob(jobId) as Record<string, unknown>;
        pollStatus = pollData.status as string;
      }
    }
    // 'snapshot' or 'wait' completed — proceed with pull
  }

  // Step 3: Check for interrupted pull
  let cursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor`);
  let resumed = false;
  if (cursor && input.restart) {
    await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
    cursor = null;
  } else if (cursor) {
    resumed = true;
  }

  // Step 4: Fetch and resolve schema (skip if resuming or skipSchema)
  let schemaFieldsAdded = 0;
  if (!resumed && !input.skipSchema) {
    try {
      const remoteSchema = await client.getSchema(jobId) as Record<string, unknown>;
      const localSchema = await input.adapter.schemaRepo.findLatest(input.projectId, input.projectId);

      if (!localSchema && remoteSchema) {
        // No local schema — accept remote
        await input.adapter.schemaRepo.create({
          jobId: input.projectId,
          tenantId: input.projectId,
          version: (remoteSchema.version as number) ?? 1,
          definition: remoteSchema,
        });
        const fields = (remoteSchema.fields ?? []) as unknown[];
        schemaFieldsAdded = fields.length;
      } else if (localSchema && remoteSchema) {
        // Both exist — diff and resolve
        const { diffSchemas } = await import('../lib/schema-diff.js');
        const diff = diffSchemas(
          localSchema.definition as { version: number; fields: Array<{ name: string; description: string; type: string; required: boolean }> },
          remoteSchema as { version: number; fields: Array<{ name: string; description: string; type: string; required: boolean }> },
        );
        if (diff.hasChanges && input.resolveSchemaConflict) {
          const choice = await input.resolveSchemaConflict(diff);
          if (choice === 'remote') {
            await input.adapter.schemaRepo.create({
              jobId: input.projectId, tenantId: input.projectId,
              version: (localSchema.version ?? 0) + 1,
              definition: remoteSchema,
              parentId: localSchema.id,
            });
            schemaFieldsAdded = diff.remoteOnly.length + diff.changed.length;
          } else if (choice === 'merge') {
            const mergedFields = [
              ...(remoteSchema.fields as unknown[]),
              ...diff.localOnly,
            ];
            await input.adapter.schemaRepo.create({
              jobId: input.projectId, tenantId: input.projectId,
              version: (localSchema.version ?? 0) + 1,
              definition: { ...remoteSchema, fields: mergedFields },
              parentId: localSchema.id,
            });
            schemaFieldsAdded = diff.remoteOnly.length;
          }
          // 'local' choice — no schema changes
        }
      }
    } catch {
      logger.warn('Schema fetch failed, continuing with entity pull');
    }
  }

  // Step 5: Handle --full flag
  if (input.full) {
    await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
    await input.metaDelete(`remote:${input.remoteName}:last_pull_at`);
    cursor = null;

    // Find all pull runs for this remote and delete their entities
    const pullRunIds = await input.adapter.runRepo.findIdsBySourcePrefix(
      `remote:${input.remoteName}:`,
    );
    if (pullRunIds.length > 0) {
      await input.adapter.entityRepo.deleteByRunIds(pullRunIds);
    }
  }

  // Determine since parameter for incremental pull
  let since: string | undefined;
  if (!cursor && !input.full) {
    const lastPullAt = await input.metaGet(`remote:${input.remoteName}:last_pull_at`);
    if (lastPullAt) since = lastPullAt;
  }

  // Create run record early so we can set runId on entities
  const run = await input.adapter.runRepo.create({
    status: 'pulled',
    source: `remote:${input.remoteName}:${jobId}`,
    configSnapshot: { remote: input.remoteName, jobId, full: !!input.full, incremental: !!since },
    startedAt,
  });

  // Fetch entities in batches
  let totalInserted = 0;
  let totalUpdated = 0;
  let batchNum = 0;

  try {
    let hasMore = true;
    while (hasMore) {
      const result = await client.getEntitiesStreamPaginated(jobId, {
        cursor: cursor ?? undefined,
        since,
        limit: 500,
      });

      const batch = (result.data ?? []).map((entity: Record<string, unknown>) => ({
        id: entity.id as string,
        mergedData: (entity.mergedData ?? {}) as Record<string, unknown>,
        provenance: (entity.provenance ?? {}) as Record<string, unknown>,
        qualityScore: (entity.qualityScore as number) ?? 0,
        categories: (entity.categories ?? []) as unknown[],
        runId: run.id,
      }));

      if (batch.length > 0) {
        const upsertResult = await input.adapter.entityRepo.upsertBatch(batch);
        totalInserted += upsertResult.inserted;
        totalUpdated += upsertResult.updated;
      }

      batchNum++;
      input.onProgress?.(batchNum, totalInserted + totalUpdated);

      // Checkpoint cursor
      cursor = result.pagination?.nextCursor ?? null;
      if (cursor) {
        await input.metaSet(`remote:${input.remoteName}:pull_cursor`, cursor);
      }

      hasMore = result.pagination?.hasMore ?? false;
    }
  } catch (err) {
    // Cursor is already checkpointed — safe to resume later
    logger.error({ err }, 'Entity pull interrupted');
    return {
      success: false,
      entitiesInserted: totalInserted,
      entitiesUpdated: totalUpdated,
      resumed,
      error: `Pull interrupted after ${batchNum} batches: ${(err as Error).message}. Run \`spatula pull\` to resume.`,
    };
  }

  // Step 6: Fetch LLM usage
  let llmTokens = 0;
  let llmCostUsd = 0;
  try {
    const usage = await client.getUsage();
    const jobUsage = usage.byJob?.find((j: { jobId: string }) => j.jobId === jobId);
    if (jobUsage) {
      llmTokens = jobUsage.tokens;
      llmCostUsd = jobUsage.costUsd;
    }
    await input.metaSet(
      `remote:${input.remoteName}:last_pull_usage`,
      JSON.stringify(usage),
    );
  } catch {
    logger.warn('Usage fetch failed, continuing');
  }

  // Step 7: Update run stats
  await input.adapter.runRepo.updateStats(run.id, {
    entitiesCreated: totalInserted,
    llmTokensUsed: llmTokens,
    llmCostUsd,
  });

  // Step 8: Clear cursor + update timestamps
  await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
  await input.metaSet(`remote:${input.remoteName}:last_pull_at`, new Date().toISOString());

  // Step 9: Return summary
  return {
    success: true,
    entitiesInserted: totalInserted,
    entitiesUpdated: totalUpdated,
    schemaFieldsAdded,
    llmTokens,
    llmCostUsd,
    resumed,
  };
}
