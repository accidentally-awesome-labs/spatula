import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadGlobalConfig, parseProjectYamlFile, yamlToJobConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';

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

export async function runPushCommand(input: PushInput): Promise<PushResult> {
  const { remoteName, projectRoot, metaGet, metaSet, autoStart = false, forceNew = false } = input;

  const config = loadGlobalConfig();
  const remote = config?.remotes?.[remoteName];
  if (!remote?.url || !remote?.apiKey) {
    return {
      success: false,
      error: `Remote "${remoteName}" not found or missing API key. Run \`spatula remote add\` first.`,
    };
  }

  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });

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
      } catch {
        // Job not found on server — proceed
      }
    }
  }

  const yaml = parseProjectYamlFile(join(projectRoot, 'spatula.yaml'));
  const jobConfig = yamlToJobConfig(yaml, {
    tenantId: '',
    projectRoot,
  });

  let jobId: string;
  try {
    const created = await client.createJob(jobConfig as unknown as Record<string, unknown>);
    jobId = (created as Record<string, unknown>).id as string;
  } catch (err) {
    return { success: false, error: `Failed to create remote job: ${(err as Error).message}` };
  }

  const configHash = createHash('sha256')
    .update(JSON.stringify(jobConfig))
    .digest('hex')
    .slice(0, 12);

  await metaSet(`remote:${remoteName}:job_id`, jobId);
  await metaSet(`remote:${remoteName}:pushed_at`, new Date().toISOString());
  await metaSet(`remote:${remoteName}:config_hash`, configHash);

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

// ---------------------------------------------------------------------------
// CLI handler — orchestrates project lifecycle around push
// ---------------------------------------------------------------------------

export interface PushCommandArgs {
  remoteName: string;
  start: boolean;
  force: boolean;
}

export async function handlePushCommand(argv: PushCommandArgs): Promise<void> {
  const { openLocalProject } = await import('../local-project.js');

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
      remoteName: argv.remoteName,
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
      console.error(
        `\n  Conflict: existing job ${result.existingJobId} is ${result.existingJobStatus}.`,
      );
      console.error('  Cancel it with `spatula remote cancel` or use `spatula push --force`.');
      process.exit(1);
    } else {
      console.error(`\n  Error: ${result.error}`);
      process.exit(1);
    }
  } finally {
    project.close();
  }
}
