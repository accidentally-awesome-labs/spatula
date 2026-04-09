#!/usr/bin/env node
/**
 * Spatula CLI — AI-powered intelligent web crawling.
 *
 * Commands:
 *   init      Initialise a new Spatula project in the current directory
 *   new       Launch interactive conversational mode to configure a crawl
 *   run       Run the local crawl pipeline for the current project
 *   status    Show local project status or remote job details
 *   add       Add seed URLs to spatula.yaml
 *   config    Open spatula.yaml in your editor
 *   setup     Configure global settings (~/.spatula/config.yaml)
 *   estimate  Estimate the LLM cost for the current project
 *   doctor    Run system health checks
 *   schema    Display the current project schema
 *   logs      View structured log files from previous runs
 *   export    Export entities to a file
 *   explore   Browse and filter extracted entities
 *   review    Review pending schema actions
 *   reset     Reset the .spatula/ working directory
 *   test      Test extraction on a single page
 *   remote    Manage remote Spatula server connections
 *   push      Push project config to a remote server and create a job
 *   list      (deprecated) List remote crawl jobs
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SpatulaApiClient } from './api/client.js';
import { runStatusCommand, runLocalStatusCommand, formatJobDetail } from './commands/status.js';
import { runInitCommand, formatInitResult } from './commands/init.js';
import { runRunCommand } from './commands/run.js';
import { runResetCommand, formatResetResult } from './commands/reset.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runAddCommand, formatAddResult } from './commands/add.js';
import { runConfigCommand } from './commands/config.js';
import { handleRemoteCommand } from './commands/remote.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a required environment variable, or exit with a clear error message.
 */
export function getEnvOrFail(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: environment variable ${name} is required but not set.`);
    process.exit(1);
  }
  return value;
}

/**
 * Create a SpatulaApiClient from resolved argv / environment.
 */
export function getApiClient(argv: { apiUrl: string; tenantId: string }): SpatulaApiClient {
  return new SpatulaApiClient(argv.apiUrl, argv.tenantId);
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

yargs(hideBin(process.argv))
  .scriptName('spatula')
  .usage('$0 <command> [options]')

  // Global options
  .option('api-url', {
    type: 'string',
    default: 'http://localhost:3000',
    describe: 'Spatula API server URL',
  })
  .option('tenant-id', {
    type: 'string',
    default: process.env.SPATULA_TENANT_ID ?? '',
    describe: 'Tenant ID (or set SPATULA_TENANT_ID)',
  })

  // -------------------------------------------------------------------------
  // init — initialise a new project directory
  // -------------------------------------------------------------------------
  .command(
    'init [url]',
    'Initialise a new Spatula project in the current directory',
    (y) =>
      y
        .positional('url', {
          type: 'string',
          describe: 'Seed URL to add to spatula.yaml',
        })
        .option('depth', {
          type: 'number',
          describe: 'Default crawl depth',
          default: 2,
        })
        .option('limit', {
          type: 'number',
          describe: 'Default page limit',
          default: 1000,
        }),
    async (argv) => {
      const result = await runInitCommand({
        url: argv.url,
        depth: argv.depth,
        limit: argv.limit,
      });
      console.log(formatInitResult(result, process.cwd()));
    },
  )

  // -------------------------------------------------------------------------
  // run — execute the local crawl pipeline
  // -------------------------------------------------------------------------
  .command(
    'run',
    'Run the local crawl pipeline for the current project',
    (y) =>
      y.option('force', {
        type: 'boolean',
        default: false,
        describe: 'Bypass the single-instance project lock',
      }),
    async (argv) => {
      await runRunCommand({ force: argv.force });
    },
  )

  // -------------------------------------------------------------------------
  // reset — wipe .spatula/ working state
  // -------------------------------------------------------------------------
  .command(
    'reset',
    'Reset the .spatula/ working directory for the current project',
    (y) =>
      y
        .option('keep-exports', {
          type: 'boolean',
          default: false,
          describe: 'Preserve the exports/ subdirectory',
        })
        .option('keep-entities', {
          type: 'boolean',
          default: false,
          describe: 'Preserve the project.db database file',
        })
        .option('keep-remote', {
          type: 'boolean',
          default: false,
          describe: 'Preserve remote job links and pulled data',
        }),
    async (argv) => {
      try {
        const result = await runResetCommand({
          keepExports: argv.keepExports,
          keepEntities: argv.keepEntities,
          keepRemote: argv.keepRemote,
        });
        console.log(formatResetResult(result));
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : 'An unexpected error occurred');
        process.exit(1);
      }
    },
  )

  // -------------------------------------------------------------------------
  // doctor — system health checks
  // -------------------------------------------------------------------------
  .command(
    'doctor',
    'Run system health checks',
    () => {},
    async () => {
      await runDoctorCommand();
    },
  )

  // -------------------------------------------------------------------------
  // add — add seed URLs to spatula.yaml
  // -------------------------------------------------------------------------
  .command(
    'add <urls..>',
    'Add seed URLs to the project',
    (y) =>
      y.positional('urls', {
        type: 'string',
        array: true,
        demandOption: true,
        describe: 'URLs to add as seeds',
      }).option('no-history', {
        type: 'boolean',
        default: false,
        describe: 'Skip crawl history dedup (allow re-adding crawled URLs)',
      }),
    async (argv) => {
      try {
        const result = await runAddCommand(argv.urls as string[], { noHistory: argv.noHistory });
        console.log(formatAddResult(result));
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : 'An unexpected error occurred');
        process.exit(1);
      }
    },
  )

  // -------------------------------------------------------------------------
  // config — open spatula.yaml in editor
  // -------------------------------------------------------------------------
  .command(
    'config',
    'Open spatula.yaml in your editor',
    () => {},
    async () => {
      await runConfigCommand();
    },
  )

  // -------------------------------------------------------------------------
  // setup — interactive global config setup
  // -------------------------------------------------------------------------
  .command(
    'setup',
    'Configure global Spatula settings (~/.spatula/config.yaml)',
    () => {},
    async () => {
      const { runSetupCommand } = await import('./commands/setup.js');
      await runSetupCommand();
    },
  )

  // -------------------------------------------------------------------------
  // estimate — estimate crawl cost
  // -------------------------------------------------------------------------
  .command(
    'estimate',
    'Estimate the LLM cost for the current project',
    () => {},
    async () => {
      const { runEstimateCommand } = await import('./commands/estimate.js');
      await runEstimateCommand();
    },
  )

  // -------------------------------------------------------------------------
  // new — interactive conversational mode
  // -------------------------------------------------------------------------
  .command(
    'new',
    'Launch interactive conversational mode to build a crawl job',
    (y) =>
      y.option('model', {
        type: 'string',
        describe: 'LLM model to use for conversation',
      }),
    async (argv) => {
      const tenantId = argv.tenantId || process.env.SPATULA_TENANT_ID || '';
      const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? '';

      // Dynamic import to avoid loading React/Ink for non-interactive commands
      const { runNewCommand } = await import('./commands/new.js');
      await runNewCommand({
        apiUrl: argv.apiUrl,
        tenantId: tenantId || undefined,
        openrouterApiKey: openrouterApiKey || undefined,
        model: argv.model,
      });
    },
  )

  // -------------------------------------------------------------------------
  // list — list jobs
  // -------------------------------------------------------------------------
  .command(
    'list',
    'List crawl jobs',
    (y) =>
      y
        .option('status', {
          type: 'string',
          describe: 'Filter by job status (e.g. running, completed, paused)',
        })
        .option('limit', {
          type: 'number',
          describe: 'Maximum number of jobs to return',
        }),
    async (argv) => {
      const { runListCommand, formatJobsTable, printListDeprecation } = await import('./commands/list.js');
      printListDeprecation();
      const tenantId = argv.tenantId || getEnvOrFail('SPATULA_TENANT_ID');
      const client = getApiClient({ apiUrl: argv.apiUrl, tenantId });
      const jobs = await runListCommand(client, {
        status: argv.status,
        limit: argv.limit,
      });
      console.log(formatJobsTable(jobs));
    },
  )

  // -------------------------------------------------------------------------
  // status — show job details (API mode) or local project status
  // -------------------------------------------------------------------------
  .command(
    'status [jobId]',
    'Show details for a specific crawl job, or local project status if no jobId given',
    (y) =>
      y.positional('jobId', {
        type: 'string',
        describe: 'The job ID to inspect (omit to show local project status)',
      }),
    async (argv) => {
      if (!argv.jobId) {
        const found = await runLocalStatusCommand(process.cwd());
        if (!found) {
          console.error(
            'Error: no spatula.yaml found. Provide a jobId or run from a project directory.',
          );
          process.exit(1);
        }
        return;
      }
      console.warn('\n  ⚠ `spatula status <jobId>` (remote) is deprecated. Use `spatula remote status <name>` (coming in a future release).\n');
      const tenantId = argv.tenantId || getEnvOrFail('SPATULA_TENANT_ID');
      const client = getApiClient({ apiUrl: argv.apiUrl, tenantId });
      const job = await runStatusCommand(client, argv.jobId);
      console.log(formatJobDetail(job));
    },
  )

  // -------------------------------------------------------------------------
  // logs — view structured run logs
  // -------------------------------------------------------------------------
  .command(
    'logs',
    'View structured log files from previous runs',
    (y) =>
      y
        .option('run', {
          type: 'string',
          describe: 'Find log by filename prefix or run ID',
        })
        .option('errors', {
          type: 'boolean',
          default: false,
          describe: 'Show only error-level entries',
        })
        .option('tail', {
          type: 'boolean',
          default: false,
          describe: 'Follow mode — watch for new entries',
        }),
    async (argv) => {
      const { runLogsCommand } = await import('./commands/logs.js');
      await runLogsCommand({
        run: argv.run,
        errors: argv.errors,
        tail: argv.tail,
      });
    },
  )

  // -------------------------------------------------------------------------
  // schema — show project schema
  // -------------------------------------------------------------------------
  .command(
    'schema',
    'Display the current project schema',
    (y) =>
      y
        .option('versions', {
          type: 'boolean',
          default: false,
          describe: 'Show version history',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Output raw schema as JSON',
        }),
    async (argv) => {
      const { runSchemaCommand } = await import('./commands/schema.js');
      await runSchemaCommand({ versions: argv.versions, json: argv.json });
    },
  )

  // -------------------------------------------------------------------------
  // export — export entities to file
  // -------------------------------------------------------------------------
  .command(
    'export',
    'Export entities to a file',
    (y) =>
      y
        .option('format', {
          type: 'string',
          choices: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'] as const,
          default: 'json',
          describe: 'Export format',
        })
        .option('output', {
          type: 'string',
          describe: 'Output file path (default: .spatula/exports/<timestamp>.<format>)',
        })
        .option('include-provenance', {
          type: 'boolean',
          default: false,
          describe: 'Include provenance data (JSON only)',
        })
        .option('min-quality', {
          type: 'number',
          describe: 'Minimum quality score filter (0-1)',
        }),
    async (argv) => {
      const { runExportCommand } = await import('./commands/export.js');
      await runExportCommand({
        format: argv.format,
        output: argv.output,
        includeProvenance: argv.includeProvenance,
        minQuality: argv.minQuality,
      });
    },
  )

  // -------------------------------------------------------------------------
  // explore — entity browser TUI
  // -------------------------------------------------------------------------
  .command(
    'explore',
    'Browse and filter extracted entities',
    () => {},
    async () => {
      const { runExploreCommand } = await import('./commands/explore.js');
      await runExploreCommand();
    },
  )

  // -------------------------------------------------------------------------
  // review — action review TUI
  // -------------------------------------------------------------------------
  .command(
    'review',
    'Review pending schema actions',
    () => {},
    async () => {
      const { runReviewCommand } = await import('./commands/review.js');
      await runReviewCommand();
    },
  )

  // -------------------------------------------------------------------------
  // test — single-page extraction (no DB/API required)
  // -------------------------------------------------------------------------
  .command(
    'test <url>',
    'Test extraction on a single page (no DB/API required)',
    (y) =>
      y
        .positional('url', { type: 'string', demandOption: true, describe: 'URL to test' })
        .option('crawler', { type: 'string', choices: ['playwright', 'firecrawl'] as const, default: 'playwright', describe: 'Crawler backend to use' })
        .option('format', { type: 'string', choices: ['json', 'table', 'raw'] as const, default: 'table', describe: 'Output format' })
        .option('schema', { type: 'string', describe: 'Path to schema JSON file' })
        .option('show-html', { type: 'boolean', default: false, describe: 'Show preprocessed HTML instead of extraction' })
        .option('show-links', { type: 'boolean', default: false, describe: 'Show evaluated links' })
        .option('model', { type: 'string', describe: 'Override LLM model' })
        .option('skip-llm', { type: 'boolean', default: false, describe: 'Skip LLM, CSS selectors only (requires --schema)' }),
    async (argv) => {
      const { testUrl } = await import('./commands/test-url.js');
      await testUrl({
        url: argv.url as string,
        crawler: argv.crawler as 'playwright' | 'firecrawl',
        format: argv.format as 'json' | 'table' | 'raw',
        schema: argv.schema,
        showHtml: argv.showHtml,
        showLinks: argv.showLinks,
        model: argv.model,
        skipLlm: argv.skipLlm,
      });
    },
  )

  // -------------------------------------------------------------------------
  // remote — manage remote server connections
  // -------------------------------------------------------------------------
  .command(
    'remote <action> [name]',
    'Manage remote Spatula server connections',
    (y) =>
      y
        .positional('action', {
          type: 'string',
          choices: ['add', 'list', 'remove', 'status', 'pause', 'resume', 'cancel', 'watch'] as const,
          demandOption: true,
          describe: 'Remote action to perform',
        })
        .positional('name', {
          type: 'string',
          describe: 'Remote name (required for all except list)',
        })
        .option('url', {
          type: 'string',
          describe: 'Server URL (for add)',
        })
        .option('key', {
          type: 'string',
          describe: 'API key (for add)',
        }),
    async (argv) => {
      await handleRemoteCommand({
        action: argv.action as string,
        name: argv.name as string | undefined,
        url: argv.url,
        key: argv.key,
      });
    },
  )

  // -------------------------------------------------------------------------
  // push — push config to remote server
  // -------------------------------------------------------------------------
  .command(
    'push [remote]',
    'Push project config to a remote Spatula server and create a job',
    (y) =>
      y
        .positional('remote', {
          type: 'string',
          default: 'default',
          describe: 'Remote name (from `spatula remote add`)',
        })
        .option('start', {
          type: 'boolean',
          default: true,
          describe: 'Start crawling immediately after push',
        })
        .option('force', {
          type: 'boolean',
          default: false,
          describe: 'Create new job even if an active job exists',
        }),
    async (argv) => {
      const { handlePushCommand } = await import('./commands/push.js');
      await handlePushCommand({
        remoteName: argv.remote as string,
        start: argv.start,
        force: argv.force,
      });
    },
  )

  // -------------------------------------------------------------------------
  // pull — pull entities and schema from a remote server
  // -------------------------------------------------------------------------
  .command(
    'pull [remote]',
    'Pull entities and schema from a remote Spatula server to the local project',
    (y) =>
      y
        .positional('remote', {
          type: 'string',
          default: 'default',
          describe: 'Remote name (from `spatula remote add`)',
        })
        .option('full', {
          type: 'boolean',
          default: false,
          describe: 'Force complete re-pull (clear previously-pulled entities)',
        })
        .option('restart', {
          type: 'boolean',
          default: false,
          describe: 'Clear interrupted pull cursor and start fresh',
        })
        .option('include-extractions', {
          type: 'boolean',
          default: false,
          describe: 'Also pull extraction records from the remote job',
        })
        .option('include-actions', {
          type: 'boolean',
          default: false,
          describe: 'Also pull action history from the remote job',
        }),
    async (argv) => {
      const { handlePullCommand } = await import('./commands/pull.js');
      await handlePullCommand({
        remoteName: argv.remote as string,
        full: argv.full,
        restart: argv.restart,
        includeExtractions: argv.includeExtractions,
        includeActions: argv.includeActions,
      });
    },
  )

  .demandCommand(1, 'Please specify a command. Run with --help to see available commands.')
  .strict()
  .help()
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'An unexpected error occurred');
    process.exit(1);
  });
