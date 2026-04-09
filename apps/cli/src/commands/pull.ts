// apps/cli/src/commands/pull.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadGlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';
import { createLogger } from '@spatula/shared';
import { openLocalProject } from '../local-project.js';
import { appendFieldsToYaml } from '../lib/yaml-fields.js';

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
    extractionRepo?: {
      upsertBatch: (batch: Array<{
        id: string; pageId: string | null; pageUrl: string | null;
        schemaVersion: number; data: Record<string, unknown>;
        unmappedFields: Record<string, unknown>[]; metadata: Record<string, unknown>;
        runId: string | null;
      }>) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
      findIdsByRunId?: (runId: string) => Promise<string[]>;
    };
    actionRepo?: {
      upsertBatch: (batch: Array<{
        id: string; type: string; payload: Record<string, unknown>;
        source: string; status: string; confidence: number;
        reasoning: string; runId: string | null;
        createdAt: string; updatedAt: string; appliedAt: string | null;
        stateChanges?: Record<string, unknown> | null;
        reviewedBy?: string | null;
      }>) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
    };
    entitySourceRepo?: {
      upsertBatchSources: (batch: Array<{
        entityId: string; extractionId: string; matchConfidence: number;
      }>) => Promise<number>;
      deleteByExtractionIds: (extractionIds: string[]) => Promise<number>;
    };
  };
  projectId: string;
  projectRoot: string;
  full?: boolean;
  restart?: boolean;
  skipSchema?: boolean;
  includeExtractions?: boolean;
  includeActions?: boolean;
  onProgress?: (batch: number, total: number) => void;
  onExtractionProgress?: (batch: number, total: number) => void;
  onActionProgress?: (batch: number, total: number) => void;
  resolveSchemaConflict?: (diff: unknown) => Promise<'remote' | 'local' | 'merge'>;
  resolveRunningJob?: (status: string, stats?: Record<string, unknown>) => Promise<'snapshot' | 'wait' | 'cancel'>;
}

export interface PullResult {
  success: boolean;
  entitiesInserted?: number;
  entitiesUpdated?: number;
  extractionsInserted?: number;
  extractionsUpdated?: number;
  entitySourcesInserted?: number;
  actionsInserted?: number;
  actionsUpdated?: number;
  schemaFieldsAdded?: number;
  newFields?: Array<{ name: string; type: string; required?: boolean }>;
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

  if (jobStatus === 'cancelled' || jobStatus === 'pending') {
    logger.warn({ jobId, status: jobStatus }, 'Job is %s — pulled data may be incomplete', jobStatus);
  }

  if (jobStatus === 'running' || jobStatus === 'paused') {
    if (!input.resolveRunningJob) {
      return { success: false, jobStatus, error: `Job is still ${jobStatus}. Use interactive mode for snapshot/wait options.` };
    }
    const choice = await input.resolveRunningJob(jobStatus, jobData.stats as Record<string, unknown>);
    if (choice === 'cancel') {
      return { success: false, error: 'Pull cancelled by user.' };
    }
    if (choice === 'wait') {
      // Poll until completed (max 30 minutes)
      const maxWaitMs = 30 * 60 * 1000;
      const waitStart = Date.now();
      let pollStatus = jobStatus;
      while (pollStatus === 'running' || pollStatus === 'paused') {
        if (Date.now() - waitStart > maxWaitMs) {
          return { success: false, error: 'Timed out waiting for job completion (30 min). Run `spatula pull` again later.' };
        }
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
  let newFields: Array<{ name: string; type: string; required?: boolean }> = [];
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
        const fields = (remoteSchema.fields ?? []) as Array<{ name: string; type: string; required?: boolean }>;
        schemaFieldsAdded = fields.length;
        newFields = fields;
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
            newFields = diff.remoteOnly;
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
            newFields = diff.remoteOnly;
          }
          // 'local' choice — no schema changes
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Schema fetch failed, continuing with entity pull');
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

  // Step 9: Pull extractions + entity sources (if --include-extractions)
  let extractionsInserted = 0;
  let extractionsUpdated = 0;
  let entitySourcesInserted = 0;

  if (input.includeExtractions && input.adapter.extractionRepo) {
    // --full cleanup: delete previously-pulled extractions and their entity_sources
    if (input.full) {
      const runIds = await input.adapter.runRepo.findIdsBySourcePrefix(`remote:${input.remoteName}:`);
      if (input.adapter.extractionRepo.findIdsByRunId && input.adapter.entitySourceRepo) {
        const extractionIds: string[] = [];
        for (const rid of runIds) {
          const ids = await input.adapter.extractionRepo.findIdsByRunId(rid);
          extractionIds.push(...ids);
        }
        await input.adapter.entitySourceRepo.deleteByExtractionIds(extractionIds);
      }
      await input.adapter.extractionRepo.deleteByRunIds(runIds);
    }

    // Resume from cursor
    if (input.restart) {
      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_extractions`);
    }
    let extrCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_extractions`);
    let extrBatch = 0;
    let extrTotal = 0;

    try {
      while (true) {
        const page = await client.getExtractionsStreamPaginated(jobId, {
          cursor: extrCursor ?? undefined,
          since: input.full ? undefined : since ?? undefined,
          limit: 100,
        });

        if (page.data.length > 0) {
          const batch = page.data.map((e: Record<string, unknown>) => ({
            id: e.id as string,
            pageId: null,
            pageUrl: (e.pageUrl as string) ?? null,
            schemaVersion: e.schemaVersion as number,
            data: e.data as Record<string, unknown>,
            unmappedFields: (e.unmappedFields ?? []) as Record<string, unknown>[],
            metadata: (e.metadata ?? {}) as Record<string, unknown>,
            runId: run.id,
          }));
          const counts = await input.adapter.extractionRepo.upsertBatch(batch);
          extractionsInserted += counts.inserted;
          extractionsUpdated += counts.updated;
          extrTotal += page.data.length;
        }

        extrBatch++;
        input.onExtractionProgress?.(extrBatch, extrTotal);

        if (!page.pagination.hasMore) break;
        extrCursor = page.pagination.nextCursor ?? null;
        if (extrCursor) {
          await input.metaSet(`remote:${input.remoteName}:pull_cursor_extractions`, extrCursor);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Extraction pull interrupted — cursor checkpointed, resume with next pull');
      return { success: false, entitiesInserted: totalInserted, entitiesUpdated: totalUpdated, extractionsInserted, extractionsUpdated, error: `Extraction pull failed: ${(err as Error).message}` };
    }

    await input.metaDelete(`remote:${input.remoteName}:pull_cursor_extractions`);

    // Pull entity sources (pulled automatically with extractions)
    if (input.adapter.entitySourceRepo) {
      if (input.restart) {
        await input.metaDelete(`remote:${input.remoteName}:pull_cursor_entity_sources`);
      }
      let esCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_entity_sources`);

      while (true) {
        const page = await client.getEntitySourcesStreamPaginated(jobId, {
          cursor: esCursor ?? undefined,
          since: input.full ? undefined : since ?? undefined,
          limit: 500,
        });

        if (page.data.length > 0) {
          const batch = page.data.map((es: Record<string, unknown>) => ({
            entityId: es.entityId as string,
            extractionId: es.extractionId as string,
            matchConfidence: es.matchConfidence as number,
          }));
          entitySourcesInserted += await input.adapter.entitySourceRepo.upsertBatchSources(batch);
        }

        if (!page.pagination.hasMore) break;
        esCursor = page.pagination.nextCursor ?? null;
        if (esCursor) {
          await input.metaSet(`remote:${input.remoteName}:pull_cursor_entity_sources`, esCursor);
        }
      }

      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_entity_sources`);
    }
  }

  // Step 10: Pull actions (if --include-actions)
  let actionsInserted = 0;
  let actionsUpdated = 0;

  if (input.includeActions && input.adapter.actionRepo) {
    if (input.full) {
      const runIds = await input.adapter.runRepo.findIdsBySourcePrefix(`remote:${input.remoteName}:`);
      await input.adapter.actionRepo.deleteByRunIds(runIds);
    }

    if (input.restart) {
      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_actions`);
    }
    let actCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_actions`);
    let actBatch = 0;
    let actTotal = 0;

    try {
      while (true) {
        const page = await client.getActionsStreamPaginated(jobId, {
          cursor: actCursor ?? undefined,
          since: input.full ? undefined : since ?? undefined,
          limit: 100,
        });

        if (page.data.length > 0) {
          const batch = page.data.map((a: Record<string, unknown>) => ({
            id: a.id as string,
            type: a.type as string,
            payload: a.payload as Record<string, unknown>,
            source: a.source as string,
            status: a.status as string,
            confidence: a.confidence as number,
            reasoning: (a.reasoning as string) ?? '',
            runId: run.id,
            createdAt: a.createdAt as string,
            updatedAt: (a.updatedAt as string) ?? new Date().toISOString(),
            appliedAt: (a.appliedAt as string) ?? null,
            stateChanges: (a.stateChanges as Record<string, unknown>) ?? null,
            reviewedBy: (a.reviewedBy as string) ?? null,
          }));
          const counts = await input.adapter.actionRepo.upsertBatch(batch);
          actionsInserted += counts.inserted;
          actionsUpdated += counts.updated;
          actTotal += page.data.length;
        }

        actBatch++;
        input.onActionProgress?.(actBatch, actTotal);

        if (!page.pagination.hasMore) break;
        actCursor = page.pagination.nextCursor ?? null;
        if (actCursor) {
          await input.metaSet(`remote:${input.remoteName}:pull_cursor_actions`, actCursor);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Action pull interrupted — cursor checkpointed, resume with next pull');
      return { success: false, entitiesInserted: totalInserted, entitiesUpdated: totalUpdated, extractionsInserted, extractionsUpdated, actionsInserted, actionsUpdated, error: `Action pull failed: ${(err as Error).message}` };
    }

    await input.metaDelete(`remote:${input.remoteName}:pull_cursor_actions`);
  }

  // Step 11: Return summary
  return {
    success: true,
    entitiesInserted: totalInserted,
    entitiesUpdated: totalUpdated,
    extractionsInserted,
    extractionsUpdated,
    entitySourcesInserted,
    actionsInserted,
    actionsUpdated,
    schemaFieldsAdded,
    newFields: newFields.length > 0 ? newFields : undefined,
    llmTokens,
    llmCostUsd,
    resumed,
  };
}

async function promptChoice(question: string, choices: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const choiceText = choices.map((c, i) => `  [${i + 1}] ${c}`).join('\n');
    rl.question(`${question}\n${choiceText}\n\nChoice: `, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(idx >= 0 && idx < choices.length ? idx : 0);
    });
  });
}

export async function handlePullCommand(opts: {
  remoteName: string;
  full?: boolean;
  restart?: boolean;
  includeExtractions?: boolean;
  includeActions?: boolean;
}): Promise<void> {
  let project: Awaited<ReturnType<typeof openLocalProject>> | null = null;

  try {
    project = await openLocalProject(process.cwd());

    const result = await runPullCommand({
      remoteName: opts.remoteName,
      metaGet: (k) => project!.metaRepo.get(k),
      metaSet: (k, v) => project!.metaRepo.set(k, v),
      metaDelete: (k) => project!.metaRepo.delete(k),
      adapter: {
        ...(project.adapter as unknown as PullInput['adapter']),
      },
      projectId: project.projectId,
      projectRoot: project.projectRoot,
      full: opts.full,
      restart: opts.restart,
      includeExtractions: opts.includeExtractions,
      includeActions: opts.includeActions,
      onProgress: (batch, total) => {
        process.stderr.write(`\r  Batch ${batch} | ${total} entities fetched`);
      },
      onExtractionProgress: (batch, total) => {
        process.stderr.write(`\r  Extractions: batch ${batch} | ${total} fetched`);
      },
      onActionProgress: (batch, total) => {
        process.stderr.write(`\r  Actions: batch ${batch} | ${total} fetched`);
      },
      resolveRunningJob: async (jobStatus: string, stats?: Record<string, unknown>) => {
        const pagesInfo = stats?.pagesProcessed ? ` (${stats.pagesProcessed} pages crawled)` : '';
        const choice = await promptChoice(
          `Job is still ${jobStatus}${pagesInfo}.`,
          [
            'Pull current snapshot (can pull again later)',
            'Wait for completion (polls every 30s)',
            'Cancel pull',
          ],
        );
        return (['snapshot', 'wait', 'cancel'] as const)[choice];
      },
      resolveSchemaConflict: async (diff) => {
        const schemaDiff = diff as import('../lib/schema-diff.js').SchemaDiff;
        if (schemaDiff.remoteOnly.length > 0) {
          console.log(`\n  Remote has ${schemaDiff.remoteOnly.length} new field(s): ${schemaDiff.remoteOnly.map(f => f.name).join(', ')}`);
        }
        if (schemaDiff.changed.length > 0) {
          console.log(`  ${schemaDiff.changed.length} field(s) changed: ${schemaDiff.changed.map(c => c.name).join(', ')}`);
        }
        if (schemaDiff.localOnly.length > 0) {
          console.log(`  ${schemaDiff.localOnly.length} local-only field(s): ${schemaDiff.localOnly.map(f => f.name).join(', ')}`);
        }
        const choice = await promptChoice(
          '\nHow should schema differences be resolved?',
          [
            'Use remote schema (recommended)',
            'Keep local schema',
            'Merge (keep all fields from both)',
          ],
        );
        return (['remote', 'local', 'merge'] as const)[choice];
      },
    });

    if (!result.success) {
      console.error(`\nPull failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    // Handle schema changes — write only NEW fields to spatula.yaml
    if (result.newFields && result.newFields.length > 0) {
      try {
        const yamlPath = join(project.projectRoot, 'spatula.yaml');
        const yamlContent = readFileSync(yamlPath, 'utf-8');
        const date = new Date().toISOString().split('T')[0];
        const updated = appendFieldsToYaml(yamlContent, result.newFields, date);
        writeFileSync(yamlPath, updated, 'utf-8');
      } catch {
        // Non-fatal: schema is in DB even if yaml write fails
      }
    }

    // Print summary
    process.stderr.write('\r' + ' '.repeat(60) + '\r');
    console.log(`\nPull complete from '${opts.remoteName}'`);
    console.log(`  Entities:  ${result.entitiesInserted} new, ${result.entitiesUpdated} updated (${(result.entitiesInserted ?? 0) + (result.entitiesUpdated ?? 0)} total)`);
    if (result.schemaFieldsAdded) {
      console.log(`  Schema:    ${result.schemaFieldsAdded} new fields`);
    }
    if (result.extractionsInserted || result.extractionsUpdated) {
      console.log(`  Extractions: ${result.extractionsInserted} new, ${result.extractionsUpdated} updated`);
    }
    if (result.entitySourcesInserted) {
      console.log(`  Provenance:  ${result.entitySourcesInserted} entity-source links`);
    }
    if (result.actionsInserted || result.actionsUpdated) {
      console.log(`  Actions:     ${result.actionsInserted} new, ${result.actionsUpdated} updated`);
    }
    if (result.llmTokens) {
      console.log(`  LLM usage: ${result.llmTokens?.toLocaleString()} tokens ($${result.llmCostUsd?.toFixed(2)})`);
    }
    if (result.resumed) {
      console.log(`  (Resumed from interrupted pull)`);
    }
  } finally {
    project?.close();
  }
}
