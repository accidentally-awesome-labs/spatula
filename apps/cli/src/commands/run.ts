/**
 * `spatula run` — run the local crawl pipeline for the current project.
 *
 * Finds spatula.yaml by walking up from cwd, parses + resolves config,
 * opens/initialises the SQLite project database, builds the pipeline
 * component graph, and runs LocalPipelineRunner until completion or SIGINT.
 *
 * DI wiring:
 *   - LLM client created from global config (provider, API keys) or env vars
 *   - Crawler created via CrawlerFactory (default: Playwright)
 *   - Extractor, Classifier, SchemaEvolver, Reconciler, LinkEvaluator built
 *     from the LLM client + resolved job config
 *   - If LLM is unavailable (no API key, no Ollama), crawl-only mode: pages
 *     are fetched but LLM-dependent steps are skipped.
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
  loadGlobalConfig,
  LocalContentStore,
  LocalPipelineRunner,
  CrawlerFactory,
  RobotsTxtChecker,
  InMemoryDomainRateLimiter,
  createLLMClient,
  CircuitBreakerLLMClient,
  resolveModel,
  PageClassifier,
  StaticExtractor,
  SchemaEvolverImpl,
  DataReconcilerImpl,
  LLMLinkEvaluator,
} from '@spatula/core';
import type { LLMClient, Crawler, LLMProvider } from '@spatula/core';
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

  // Step 3: Load global config (API keys, provider preferences)
  let globalConfig: ReturnType<typeof loadGlobalConfig> = null;
  try {
    globalConfig = loadGlobalConfig();
  } catch {
    // Non-fatal: global config is optional
  }

  const jobConfig = yamlToJobConfig(projectYaml, {
    tenantId: projectId,
    projectId,
    projectRoot,
    globalConfig,
  });

  // Step 3b: Set up structured logging to .spatula/logs/
  const logsDir = join(projectRoot, '.spatula', 'logs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, `${new Date().toISOString().replace(/:/g, '-').slice(0, 19)}.log`);
  const { appendFileSync } = await import('node:fs');
  // Simple structured JSON log appender (avoids Pino transport complexity)
  const logToFile = (entry: Record<string, unknown>) => {
    try { appendFileSync(logFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n'); } catch { /* non-fatal */ }
  };
  console.log(`  Log: ${logFile}`);

  // Step 4: Open SQLite DB and initialise (apply migrations + seed project meta)
  const dbPath = join(projectRoot, '.spatula', 'project.db');
  const { db, close: closeDb } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId, name: projectName });

  // Step 5: Build ProjectAdapter (assembles all 12 SQLite repositories)
  const adapter = new ProjectAdapter(db, projectId);

  // Step 6: Build LocalContentStore (raw HTML under .spatula/pages/)
  const pagesDir = join(projectRoot, '.spatula', 'pages');
  const contentStore = new LocalContentStore(pagesDir);

  // Step 7: Create LLM client (graceful degradation if unavailable)
  // If the LLM provider is unreachable or misconfigured, the pipeline
  // operates in crawl-only mode (pages fetched, no extraction).
  let llmClient: LLMClient | null = null;
  const llmConfig = jobConfig.llm;

  try {
    const provider: LLMProvider =
      globalConfig?.llm?.provider ?? 'ollama';

    const rawClient = createLLMClient({
      provider,
      openrouter: provider === 'openrouter'
        ? {
            apiKey:
              globalConfig?.openrouterApiKey ??
              process.env.OPENROUTER_API_KEY ??
              '',
            baseUrl: process.env.OPENROUTER_BASE_URL,
          }
        : undefined,
      ollama: provider === 'ollama'
        ? { baseUrl: process.env.OLLAMA_BASE_URL }
        : undefined,
    });

    // Wrap cloud providers with circuit breaker; skip for Ollama (local, terminal failures)
    llmClient =
      provider === 'openrouter'
        ? new CircuitBreakerLLMClient(rawClient)
        : rawClient;
  } catch (err) {
    console.warn(
      `  Warning: LLM unavailable (${err instanceof Error ? err.message : String(err)}).` +
      '\n  Pipeline will crawl pages but skip classification, extraction, and reconciliation.\n',
    );
  }

  // Step 8: Create crawler (async — Playwright launches a browser)
  const crawlerType = jobConfig.crawl?.crawlerType ?? 'playwright';
  let crawler: Crawler | null = null;
  try {
    crawler = await CrawlerFactory.create({
      type: crawlerType as 'playwright' | 'firecrawl',
      firecrawlApiKey: globalConfig?.firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY,
    });
  } catch (err) {
    console.error(
      `Error: Failed to create ${crawlerType} crawler: ${err instanceof Error ? err.message : String(err)}`,
    );
    closeDb();
    process.exit(1);
  }

  // Step 9: Build LLM-dependent components (null when LLM is unavailable)
  const classifier = llmClient ? new PageClassifier(llmClient, llmConfig) : null;
  const extractor = llmClient
    ? new StaticExtractor(llmClient, llmConfig, jobConfig.tenantId)
    : null;
  const schemaEvolver = llmClient ? new SchemaEvolverImpl(llmClient, llmConfig) : null;
  const reconciler = llmClient ? new DataReconcilerImpl(llmClient, llmConfig) : null;
  const linkEvaluator = llmClient
    ? new LLMLinkEvaluator(llmClient, resolveModel(llmConfig, 'linkEvaluation'))
    : null;

  // Step 10: Create crawl infrastructure
  const robotsChecker = new RobotsTxtChecker();
  const rateLimiter = new InMemoryDomainRateLimiter();

  // Step 11: Build LocalPipelineRunner
  const runner = new LocalPipelineRunner({
    adapter,
    config: {
      ...jobConfig,
      // Pass YAML-only export config so the runner can honour autoExport
      export: projectYaml.export,
    } as any,
    projectDir: projectRoot,
    crawler,
    extractor,
    classifier,
    contentStore,
    schemaEvolver,
    reconciler,
    linkEvaluator,
    robotsChecker,
    rateLimiter,
    force: options.force,
  } as any);

  // Step 12: SIGINT handler — graceful stop (second Ctrl+C force-quits)
  let stopping = false;
  const handleSigint = () => {
    if (stopping) {
      process.stdout.write('\n');
      console.log('Force-quitting.');
      crawler?.close().catch(() => {});
      closeDb();
      process.exit(1);
    }
    stopping = true;
    process.stdout.write('\n');
    console.log('Stopping crawl gracefully... (Ctrl+C again to force quit)');
    runner.stop();
  };
  process.on('SIGINT', handleSigint);

  // Step 13: Subscribe to progress events — single overwritten stdout line
  const startTime = Date.now();

  runner.events.on('progress', (stats: any) => {
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
    // Log to file
    logToFile({ event: 'progress', ...stats, elapsed });
  });

  runner.events.on('schema:evolved', (schema: any) => {
    // Print on a new line so the evolution message isn't overwritten
    process.stdout.write('\n');
    console.log(`  Schema evolved → version ${schema.version}`);
  });

  // Step 14: Print startup summary and run the pipeline
  console.log(`\nSpatula — running pipeline for: ${projectName}`);
  console.log(`  Project root : ${projectRoot}`);
  console.log(`  Database     : ${dbPath}`);
  console.log(`  Crawler      : ${crawlerType}`);
  console.log(`  LLM          : ${llmClient ? 'available' : 'unavailable (crawl-only mode)'}`);
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
    await crawler?.close().catch(() => {});
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
