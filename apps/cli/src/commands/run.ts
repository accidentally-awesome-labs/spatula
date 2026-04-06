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
 */

import { join, basename } from 'node:path';
import { slugifyPath } from '../local-project.js';
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
import type { LLMClient, Crawler, LLMProvider, DataSource } from '@spatula/core';
import { LocalDataSource } from '@spatula/core';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';
import { sendDesktopNotification, sendWebhookNotification } from '../notifications.js';

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
  const projectId = slugifyPath(projectRoot);
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
  const logToFile = (level: string, msg: string, extra: Record<string, unknown> = {}) => {
    try {
      appendFileSync(logFile, JSON.stringify({
        level, msg, ...extra, ts: new Date().toISOString(),
      }) + '\n');
    } catch { /* non-fatal */ }
  };
  console.log(`  Log: ${logFile}`);

  // Step 4: Open SQLite DB and initialise (apply migrations + seed project meta)
  const dbPath = join(projectRoot, '.spatula', 'project.db');
  const { db, close: closeDb } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId, name: projectName });

  // Step 5: Build ProjectAdapter (assembles all 12 SQLite repositories)
  const adapter = new ProjectAdapter(db, projectId);

  // Step 5b: Create DataSource for dashboard polling
  const dataSource: DataSource = new LocalDataSource(adapter);

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

  // Dashboard toggle state (declared here so the progress handler can read suppressProgress)
  let dashboardActive = false;
  let dashboardUnmount: (() => void) | null = null;
  let suppressProgress = false;

  runner.events.on('progress', (stats: any) => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const pct =
      stats.totalPages > 0
        ? Math.round((stats.pagesProcessed / stats.totalPages) * 100)
        : 0;
    if (!suppressProgress) {
      process.stdout.write(
        `\r  Pages: ${stats.pagesProcessed}/${stats.totalPages} (${pct}%)` +
        `  Entities: ${stats.entitiesCreated}` +
        `  Errors: ${stats.errors}` +
        `  Elapsed: ${elapsed}s  `,
      );
    }
    // Log to file
    logToFile('info', 'Progress', { event: 'progress', pagesProcessed: stats.pagesProcessed, totalPages: stats.totalPages, entitiesCreated: stats.entitiesCreated, errors: stats.errors, elapsed });
  });

  runner.events.on('schema:evolved', (schema: any) => {
    // Print on a new line so the evolution message isn't overwritten
    process.stdout.write('\n');
    console.log(`  Schema evolved → version ${schema.version}`);
    logToFile('info', `Schema evolved to version ${schema.version}`, { event: 'schema:evolved', version: schema.version });
  });

  // Step 13b: Dashboard toggle handlers

  const handleKeypress = (key: string) => {
    if (key === '\x03') { // Ctrl+C
      handleSigint();
      return;
    }
    if (key === 'd' || key === 'D') {
      if (dashboardActive) {
        dismissDashboard();
      } else {
        showDashboard().catch((err) => {
          console.error('Dashboard error:', err instanceof Error ? err.message : String(err));
          dashboardActive = false;
          suppressProgress = false;
        });
      }
    }
  };

  const showDashboard = async () => {
    dashboardActive = true;
    suppressProgress = true;
    process.stdin.removeListener('data', handleKeypress);

    const React = (await import('react')).default;
    const { render: inkRender } = await import('ink');
    const { RunDashboard, buildRunDashboardStore } = await import(
      '../components/dashboard/RunDashboard.js'
    );

    const dashStore = buildRunDashboardStore(projectId);

    const { unmount } = inkRender(
      React.createElement(RunDashboard, {
        store: dashStore,
        dataSource,
        projectName,
        onDismiss: () => dismissDashboard(),
      }),
      { exitOnCtrlC: false },
    );

    dashboardUnmount = unmount;
  };

  const dismissDashboard = () => {
    if (!dashboardActive) return; // Already dismissed
    if (dashboardUnmount) {
      dashboardUnmount();
      dashboardUnmount = null;
    }
    dashboardActive = false;
    suppressProgress = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', handleKeypress);
    }
    console.log(''); // Clean line after dashboard
  };

  // Set up stdin raw mode for keyboard shortcuts
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', handleKeypress);
  }
  console.log('  Press [d] for dashboard view\n');

  // Step 14: Print startup summary and run the pipeline
  console.log(`\nSpatula — running pipeline for: ${projectName}`);
  console.log(`  Project root : ${projectRoot}`);
  console.log(`  Database     : ${dbPath}`);
  console.log(`  Crawler      : ${crawlerType}`);
  console.log(`  LLM          : ${llmClient ? 'available' : 'unavailable (crawl-only mode)'}`);
  console.log(`  Seed URLs    : ${(jobConfig.seedUrls ?? []).join(', ')}`);
  console.log('');

  try {
    logToFile('info', `Pipeline starting for ${projectName}`, { event: 'run:start', projectName, projectRoot, crawler: crawlerType, llm: llmClient ? 'available' : 'unavailable' });
    await runner.run();

    // Ensure the in-place progress line ends cleanly
    process.stdout.write('\n');
    console.log('\nPipeline complete.');
    logToFile('info', 'Pipeline complete', { event: 'run:complete' });

    // Notifications on success
    await sendDesktopNotification('Spatula', `Pipeline complete for ${projectName}`);
    if (projectYaml.notify?.webhook) {
      await sendWebhookNotification(projectYaml.notify.webhook, {
        type: 'pipeline:complete',
        data: { projectName, projectRoot },
      });
    }
  } catch (err) {
    process.stdout.write('\n');
    console.error('\nPipeline failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;

    // Notifications on failure
    const errMsg = err instanceof Error ? err.message : String(err);
    logToFile('error', `Pipeline failed: ${errMsg}`, { event: 'run:failed', error: errMsg });
    await sendDesktopNotification('Spatula', `Pipeline failed: ${errMsg}`);
    if (projectYaml.notify?.webhook) {
      await sendWebhookNotification(projectYaml.notify.webhook, {
        type: 'pipeline:failed',
        data: { projectName, projectRoot, error: errMsg },
      });
    }
  } finally {
    if (dashboardActive) dismissDashboard();
    if (process.stdin.isTTY) {
      process.stdin.removeListener('data', handleKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.off('SIGINT', handleSigint);
    await crawler?.close().catch(() => {});
    closeDb();
  }
}

