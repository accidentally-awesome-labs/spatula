#!/usr/bin/env node
/**
 * Spatula CLI — AI-powered intelligent web crawling.
 *
 * Commands:
 *   new      Launch interactive conversational mode to configure and start a crawl job
 *   list     List crawl jobs
 *   status   Show details for a specific job
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SpatulaApiClient } from './api/client.js';
import { runListCommand, formatJobsTable } from './commands/list.js';
import { runStatusCommand, formatJobDetail } from './commands/status.js';

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
      const tenantId = argv.tenantId || getEnvOrFail('SPATULA_TENANT_ID');
      const openrouterApiKey = getEnvOrFail('OPENROUTER_API_KEY');

      // Dynamic import to avoid loading React/Ink for non-interactive commands
      const { runNewCommand } = await import('./commands/new.js');
      await runNewCommand({
        apiUrl: argv.apiUrl,
        tenantId,
        openrouterApiKey,
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
  // status — show job details
  // -------------------------------------------------------------------------
  .command(
    'status <jobId>',
    'Show details for a specific crawl job',
    (y) =>
      y.positional('jobId', {
        type: 'string',
        demandOption: true,
        describe: 'The job ID to inspect',
      }),
    async (argv) => {
      const tenantId = argv.tenantId || getEnvOrFail('SPATULA_TENANT_ID');
      const client = getApiClient({ apiUrl: argv.apiUrl, tenantId });
      const job = await runStatusCommand(client, argv.jobId as string);
      console.log(formatJobDetail(job));
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
