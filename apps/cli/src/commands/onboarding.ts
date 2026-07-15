import { basename } from 'node:path';
import { findProjectRoot, loadGlobalConfig } from '@accidentally-awesome-labs/spatula-core';
import { runInitCommand } from './init.js';
import { runSetupCommand } from './setup.js';
import { runRunCommand } from './run.js';
import { runEstimateCommand } from './estimate.js';
import { openLocalProject } from '../local-project.js';
import {
  collectPreflightIssues,
  formatPreflightIssues,
  resolveRuntimeConfig,
} from '../runtime-preflight.js';
import { processPromptIO, promptConfirm, promptText, type PromptIO } from '../lib/prompts.js';

const SAMPLE_URL = 'https://books.toscrape.com/';

type FieldType = 'string' | 'number' | 'boolean' | 'url' | 'currency';

export interface OnboardingField {
  name: string;
  type: FieldType;
  required?: boolean;
}

export interface EmptyResultDiagnostics {
  schemaFields: number | null;
  taskStats: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  failures: Array<{
    url: string;
    errorMessage: string | null;
    attempts: number | null;
  }>;
}

export function formatEmptyResultDiagnostics(details: EmptyResultDiagnostics): string[] {
  const lines = ['  The crawl finished, but no structured entities were extracted.'];

  if (details.schemaFields === null) {
    lines.push(
      '  No extraction schema exists for this local project.',
      '  Run `spatula run` to initialize it from the fields in spatula.yaml.',
    );
    return lines;
  }

  if (details.failures.length > 0) {
    lines.push('', '  Crawl failures:');
    for (const failure of details.failures) {
      const message = failure.errorMessage ?? 'Unknown crawl error';
      lines.push(`  • ${failure.url} — ${message}`);
    }
    lines.push(
      '',
      '  Fix the failed seed URL or crawler configuration, then run `spatula run` again.',
      '  Full details: `spatula logs --errors`',
    );
    return lines;
  }

  if (details.taskStats.pending > 0 || details.taskStats.inProgress > 0) {
    lines.push(
      `  Crawl work remains (${details.taskStats.pending} pending, ${details.taskStats.inProgress} in progress).`,
      '  Run `spatula run` again to resume it.',
    );
    return lines;
  }

  if (details.taskStats.completed > 0) {
    lines.push(
      `  ${details.taskStats.completed} page(s) completed, but none were extractable for the requested fields.`,
      '  Check that the seed points to a real listing or detail page and review `spatula.yaml`.',
    );
    return lines;
  }

  if (details.taskStats.skipped > 0) {
    lines.push(
      `  ${details.taskStats.skipped} page(s) were skipped by crawl policy.`,
      '  Run `spatula doctor` to inspect project and crawler configuration.',
    );
    return lines;
  }

  lines.push('  No crawl tasks were processed. Check the seed URLs in spatula.yaml.');
  return lines;
}

export function inferFields(description: string): OnboardingField[] {
  const pieces = description
    .split(/[,\n]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const fields: OnboardingField[] = [];

  for (const piece of pieces) {
    const name = piece
      .toLowerCase()
      .replace(/\b(the|a|an|product|book|item|field|their|its)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    let type: FieldType = 'string';
    if (/price|cost|amount|salary|revenue/.test(name)) type = 'currency';
    else if (/url|link|image|website/.test(name)) type = 'url';
    else if (/available|in_stock|enabled|active|sold_out/.test(name)) type = 'boolean';
    else if (/count|rating|score|quantity|year|number/.test(name)) type = 'number';
    fields.push({ name, type, required: fields.length === 0 });
  }

  return fields.length > 0
    ? fields
    : [
        { name: 'title', type: 'string', required: true },
        { name: 'description', type: 'string' },
      ];
}

function line(io: PromptIO, value = ''): void {
  io.output.write(`${value}\n`);
}

async function previewResults(io: PromptIO, cwd: string): Promise<boolean> {
  const project = await openLocalProject(cwd);
  try {
    const result = await project.dataSource.getEntities({ limit: 3, offset: 0 });
    if (result.total === 0) {
      const [schema, taskStats, failures] = await Promise.all([
        project.adapter.schemaRepo.findLatest(project.projectId, project.projectId),
        project.adapter.taskRepo.getJobStats(project.projectId, project.projectId),
        project.adapter.taskRepo.findRecentFailures(project.projectId, 5),
      ]);
      const fields = schema ? (schema.definition as { fields?: unknown }).fields : undefined;
      const schemaFields = schema
        ? Array.isArray(fields)
          ? fields.length
          : fields && typeof fields === 'object'
            ? Object.keys(fields as Record<string, unknown>).length
            : 0
        : null;

      line(io);
      for (const diagnosticLine of formatEmptyResultDiagnostics({
        schemaFields,
        taskStats,
        failures,
      })) {
        line(io, diagnosticLine);
      }
      return false;
    }

    line(io);
    line(io, `  Extracted ${result.total} ${result.total === 1 ? 'entity' : 'entities'}. Preview:`);
    for (const entity of result.data) {
      const summary = JSON.stringify(entity.mergedData ?? {});
      line(io, `  • ${summary.length > 180 ? `${summary.slice(0, 177)}…` : summary}`);
    }
    line(io);
    line(io, '  Next: `spatula explore` or `spatula export --format json`');
    return true;
  } finally {
    project.close();
  }
}

export async function runGuidedOnboarding(io: PromptIO = processPromptIO): Promise<void> {
  line(io);
  line(io, '  Welcome to Spatula');
  line(io, '  Describe the data you want; Spatula will crawl and structure it.');
  line(io, `  ${'-'.repeat(64)}`);

  let savedConfig: ReturnType<typeof loadGlobalConfig> = null;
  try {
    savedConfig = loadGlobalConfig();
  } catch (error) {
    line(io);
    line(
      io,
      `  Saved configuration needs repair: ${error instanceof Error ? error.message : String(error)}`,
    );
    const setup = await runSetupCommand({ input: io.input, output: io.output });
    if (setup.provider.status === 'fail' || setup.browser?.status === 'fail') return;
    savedConfig = loadGlobalConfig();
  }

  let runtime = resolveRuntimeConfig(savedConfig);
  let issues = collectPreflightIssues(runtime);
  if (issues.length > 0) {
    line(io);
    line(io, '  First, let’s finish setup:');
    line(io, formatPreflightIssues(issues));
    const setup = await runSetupCommand({ input: io.input, output: io.output });
    if (setup.provider.status === 'fail' || setup.browser?.status === 'fail') return;
    runtime = resolveRuntimeConfig(loadGlobalConfig());
    issues = collectPreflightIssues(runtime);
    if (issues.length > 0) {
      line(io, formatPreflightIssues(issues));
      process.exitCode = 1;
      return;
    }
  }

  const cwd = process.cwd();
  let projectRoot = findProjectRoot(cwd);
  if (projectRoot) {
    line(io);
    line(io, `  Existing project found: ${projectRoot}`);
  } else {
    line(io);
    const enteredUrl = await promptText(`  Seed URL [${SAMPLE_URL}]: `, io);
    const isSample = enteredUrl.length === 0;
    const rawUrl = enteredUrl || SAMPLE_URL;
    let url: string;
    try {
      url = new URL(rawUrl).href;
    } catch {
      throw new Error(`Invalid seed URL: ${rawUrl}`);
    }

    let fields: OnboardingField[];
    let name: string;
    let description: string;
    let limit: number;
    let depth: number;

    if (isSample) {
      name = 'Books quickstart';
      description = 'Practice crawl extracting structured book listings';
      limit = 10;
      depth = 2;
      fields = [
        { name: 'title', type: 'string', required: true },
        { name: 'price', type: 'currency' },
        { name: 'availability', type: 'string' },
        { name: 'rating', type: 'number' },
      ];
      line(io, '  Using the safe Books to Scrape practice site (10-page limit).');
    } else {
      const wanted = await promptText(
        '  What fields do you want? Separate them with commas [title, description]: ',
        io,
      );
      fields = inferFields(wanted || 'title, description');
      name = `${new URL(url).hostname} crawl`;
      description = wanted || 'Structured page data';
      limit = 25;
      depth = 2;
    }

    line(io);
    line(io, '  Crawl plan');
    line(io, `  Target  : ${url}`);
    line(io, `  Pages   : up to ${limit}`);
    line(io, `  Crawler : ${runtime.crawler}`);
    line(io, `  Model   : ${runtime.model}`);
    line(io, `  Fields  : ${fields.map((field) => `${field.name} (${field.type})`).join(', ')}`);
    line(io, '  Only crawl sites you are permitted to access; robots.txt is respected by default.');

    const create = await promptConfirm('  Create this project?', true, io);
    if (!create) {
      line(io, '  No files were created.');
      return;
    }

    await runInitCommand({
      cwd,
      url,
      name,
      description,
      depth,
      limit,
      fields,
    });
    projectRoot = cwd;
    line(
      io,
      `  Created ${basename(projectRoot)}${projectRoot === cwd ? '' : ` at ${projectRoot}`}.`,
    );
  }

  await runEstimateCommand();
  const run = await promptConfirm('  Start the crawl now?', true, io);
  if (!run) {
    line(io, '  Project saved. Start later with `spatula run`.');
    return;
  }

  await runRunCommand();
  if (process.exitCode && process.exitCode !== 0) return;
  const hasResults = await previewResults(io, projectRoot);
  if (!hasResults) process.exitCode = 1;
}
