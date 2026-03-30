/**
 * `spatula run` — run the local crawl pipeline for the current project.
 *
 * Finds spatula.yaml by walking up from cwd, parses + resolves config,
 * opens/initialises the SQLite project database, builds the pipeline
 * component graph, and runs LocalPipelineRunner until completion or SIGINT.
 *
 * Crawler, extractor, and classifier dependencies are stubbed as null with
 * TODO comments for Phase 13 Step 4, when the real implementations will be
 * wired in.
 *
 * TODO(Wave 3-5 Task 10): Structured file logging — add a Pino file transport
 * that writes newline-delimited JSON to `.spatula/logs/<run-id>.ndjson` so that
 * each run produces a persistent, machine-readable audit trail.  The transport
 * can be created with `pino.transport({ target: 'pino/file', options: { destination: logPath } })`
 * and passed as the second argument to `createLogger`.
 */

import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  findProjectRoot,
  parseProjectYaml,
  yamlToJobConfig,
  LocalContentStore,
  LocalPipelineRunner,
} from '@spatula/core';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';

// ---------------------------------------------------------------------------
// Public run function
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Skip the single-instance lock check (useful for debugging). */
  force?: boolean;
}

export async function runRunCommand(options: RunOptions = {}): Promise<void> {
  const cwd = process.cwd();

  // Step 1: Find project root by walking up from cwd
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    console.error(
      'Error: no spatula.yaml found. Run `spatula init` to create a project here.',
    );
    process.exit(1);
  }

  // Step 2: Parse spatula.yaml + resolve JobConfig
  const yamlPath = join(projectRoot, 'spatula.yaml');
  const yamlContent = readFileSync(yamlPath, 'utf-8');
  const projectYaml = parseProjectYaml(yamlContent);

  // Derive a stable, human-readable project ID from the last two path segments.
  // e.g. /home/user/projects/my-crawl → "projects-my-crawl"
  const projectId = slugify(projectRoot);
  const projectName = projectYaml.name ?? basename(projectRoot);

  const jobConfig = yamlToJobConfig(projectYaml, {
    tenantId: projectId,
    projectId,
    projectRoot,
    // TODO(Phase 13 Step 4): load ~/.spatula/config.yaml via loadGlobalConfig
    globalConfig: null,
  });

  // Step 3: Open SQLite DB and initialise (apply migrations + seed project meta)
  const dbPath = join(projectRoot, '.spatula', 'project.db');
  const { db, close: closeDb } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId, name: projectName });

  // Step 4: Build ProjectAdapter (assembles all 12 SQLite repositories)
  const adapter = new ProjectAdapter(db, projectId);

  // Step 5: Build LocalContentStore (raw HTML under .spatula/pages/)
  const pagesDir = join(projectRoot, '.spatula', 'pages');
  const contentStore = new LocalContentStore(pagesDir);

  // Step 6: Build LocalPipelineRunner
  //
  // Crawler, extractor, and classifier are stubbed as null.
  // TODO(Phase 13 Step 4): replace with:
  //   crawler    → new PlaywrightCrawler(...)
  //   extractor  → new LlmExtractor(...)
  //   classifier → new PageClassifier(...)
  // Also wire schemaEvolver and reconciler once those packages land.
  const runner = new LocalPipelineRunner({
    adapter,
    config: {
      ...jobConfig,
      // Pass YAML-only export config so the runner can honour autoExport
      export: projectYaml.export,
    } as any,
    projectDir: projectRoot,
    crawler: null,       // TODO: replace with PlaywrightCrawler
    extractor: null,     // TODO: replace with LlmExtractor
    classifier: null,    // TODO: replace with PageClassifier
    contentStore,
    schemaEvolver: null, // TODO: replace with SchemaEvolver
    reconciler: null,    // TODO: replace with Reconciler
  } as any);

  // Step 7: SIGINT handler — graceful stop (second Ctrl+C force-quits)
  let stopping = false;
  const handleSigint = () => {
    if (stopping) {
      process.stdout.write('\n');
      console.log('Force-quitting.');
      closeDb();
      process.exit(1);
    }
    stopping = true;
    process.stdout.write('\n');
    console.log('Stopping crawl gracefully... (Ctrl+C again to force quit)');
    runner.stop();
  };
  process.on('SIGINT', handleSigint);

  // Step 8: Subscribe to progress events — single overwritten stdout line
  const startTime = Date.now();

  runner.events.on('progress', (stats) => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const pct =
      stats.totalPages > 0
        ? Math.round((stats.pagesProcessed / stats.totalPages) * 100)
        : 0;
    process.stdout.write(
      `\r  Pages: ${stats.pagesProcessed}/${stats.totalPages} (${pct}%)` +
      `  Entities: ${stats.entitiesCreated}` +
      `  Errors: ${stats.errors}` +
      `  Elapsed: ${elapsed}s  `,
    );
  });

  runner.events.on('schema:evolved', (schema) => {
    // Print on a new line so the evolution message isn't overwritten
    process.stdout.write('\n');
    console.log(`  Schema evolved → version ${schema.version}`);
  });

  // Step 9: Print startup summary and run the pipeline
  console.log(`\nSpatula — running pipeline for: ${projectName}`);
  console.log(`  Project root : ${projectRoot}`);
  console.log(`  Database     : ${dbPath}`);
  console.log(`  Seed URLs    : ${(jobConfig.seedUrls ?? []).join(', ')}`);
  console.log('');

  try {
    await runner.run();

    // Ensure the in-place progress line ends cleanly
    process.stdout.write('\n');
    console.log('\nPipeline complete.');
  } catch (err) {
    process.stdout.write('\n');
    console.error('\nPipeline failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', handleSigint);
    closeDb();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a simple project-ID slug using the last two
 * path segments, lowercased and non-alphanumeric characters replaced with `-`.
 *
 * Examples:
 *   /home/user/projects/my-crawl → "projects-my-crawl"
 *   C:\Users\me\data\crawl-test  → "data-crawl-test"
 */
function slugify(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}
