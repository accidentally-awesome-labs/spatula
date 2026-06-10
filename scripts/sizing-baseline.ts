/**
 * scripts/sizing-baseline.ts
 *
 * DEPLOY-09: Hardware-sizing baseline harness.
 *
 * Runs a 1000-page crawl ONCE PER routing tier (fast / primary / smart) on one
 * defined cloud VM and records wall-clock time + LLM cost-per-page. The results
 * are emitted as a Markdown table to stdout AND written to
 * scripts/.sizing-results.json so the hardware-sizing.md runbook table can be
 * filled from them.
 *
 * == Target hardware (D-01) ==
 * Hetzner CX32  —  4 vCPU / 8 GB RAM / 80 GB SSD NVMe / AMD EPYC (amd64)
 * Hetzner Cloud is a reproducible, budget cloud VM widely accessible to
 * self-hosters (EUR ~0.05/h on-demand). Substitute your own VM class and note
 * it in hardware-sizing.md; results vary by hardware, network, and target site.
 *
 * == Routing tiers (D-02) ==
 * fast    — google/gemini-2.5-flash   (cheapest, high-throughput)
 * primary — anthropic/claude-sonnet-4-20250514  (balanced — production default)
 * smart   — anthropic/claude-opus-4-20250514    (highest quality, highest cost)
 *
 * Each tier pins all LLM calls to one model via LLMConfig.primaryModel (no
 * per-task overrides). This produces a clean per-tier cost/page number.
 *
 * == Usage / cost surface ==
 * LLM usage is recorded to Postgres via LlmUsageRepository (per-call).
 * After the crawl, this harness queries aggregateByTenant() restricted to the
 * job ID, sums totalCostUsd, and divides by pages_completed.
 *
 * == Re-run instructions ==
 * See docs/runbooks/hardware-sizing.md — run with:
 *   SPATULA_LIVE_LLM=1 OPENROUTER_API_KEY=... DATABASE_URL=... pnpm sizing:baseline
 * or use the package.json script (which sets SPATULA_LIVE_LLM=1 automatically).
 *
 * Results vary by: target site structure, network latency, VM I/O, model
 * pricing changes. Re-run after significant infrastructure or model changes.
 */

// ============================================================
// LIVE GATE — must be first executable line
// ============================================================
if (process.env.SPATULA_LIVE_LLM !== '1') {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to run: set SPATULA_LIVE_LLM=1 to confirm this harness will incur real LLM cost.\n' +
      'Use: SPATULA_LIVE_LLM=1 pnpm sizing:baseline\n' +
      '  or run via: pnpm sizing:baseline  (the package.json script sets the gate automatically)',
  );
  process.exit(2);
}

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Tier definitions (D-02)
// ============================================================
interface TierConfig {
  name: 'fast' | 'primary' | 'smart';
  model: string;
  description: string;
}

const TIERS: TierConfig[] = [
  {
    name: 'fast',
    model: 'google/gemini-2.5-flash',
    description: 'Cheap, high-throughput model — lowest latency and cost',
  },
  {
    name: 'primary',
    model: 'anthropic/claude-sonnet-4-20250514',
    description: 'Balanced model — production default',
  },
  {
    name: 'smart',
    model: 'anthropic/claude-opus-4-20250514',
    description: 'Highest quality model — best extraction, highest cost',
  },
];

// ============================================================
// Configuration (overridable via env / CLI args)
// ============================================================
const TARGET_PAGES = parseInt(process.env.SIZING_PAGES ?? '1000', 10);
const SEED_URL = process.env.SIZING_SEED_URL ?? 'https://quotes.toscrape.com/';
const TENANT_ID = process.env.SIZING_TENANT_ID ?? 'sizing-baseline-tenant';

// ============================================================
// Per-tier result
// ============================================================
interface TierResult {
  tier: 'fast' | 'primary' | 'smart';
  model: string;
  pages: number;
  wallClockMs: number;
  wallClockFormatted: string;
  totalCostUsd: number;
  costPerPageUsd: number;
}

// ============================================================
// Helpers
// ============================================================

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function printMarkdownTable(results: TierResult[]): void {
  // eslint-disable-next-line no-console
  const log = console.log.bind(console);
  log('\n## Sizing Baseline Results\n');
  log(`Target VM: Hetzner CX32 (4 vCPU / 8 GB RAM / 80 GB SSD NVMe)`);
  log(`Seed URL:  ${SEED_URL}`);
  log(`Pages/tier: ${TARGET_PAGES}\n`);
  log('| Tier    | Model                                  | Pages | Wall-clock | Total LLM cost | LLM cost/page |');
  log('| ------- | -------------------------------------- | ----- | ---------- | -------------- | ------------- |');
  for (const r of results) {
    log(
      `| ${r.tier.padEnd(7)} | ${r.model.padEnd(38)} | ${String(r.pages).padEnd(5)} | ${r.wallClockFormatted.padEnd(10)} | ${formatCost(r.totalCostUsd).padEnd(14)} | ${formatCost(r.costPerPageUsd).padEnd(13)} |`,
    );
  }
  log('');
}

// ============================================================
// Main execution
// ============================================================

async function runTier(tier: TierConfig): Promise<TierResult> {
  // eslint-disable-next-line no-console
  const log = (...args: unknown[]) => console.log(`[${tier.name}]`, ...args);

  log(`Starting ${TARGET_PAGES}-page crawl with model: ${tier.model}`);
  log(`Seed URL: ${SEED_URL}`);

  // Dynamic imports to avoid top-level DB/queue boot when gate is unset.
  // In a real run these packages are available via the monorepo workspace.
  let createDb: (url: string) => unknown;
  let LlmUsageRepository: new (db: unknown) => {
    aggregateByTenant: (
      tenantId: string,
      since: Date,
    ) => Promise<{ totalCostUsd: number; byJob: Array<{ jobId: string; costUsd: number }> }>;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = await import('@spatula/db');
    createDb = (dbMod as { createDb?: (url: string) => unknown }).createDb as typeof createDb;
    LlmUsageRepository = (
      dbMod as { LlmUsageRepository?: typeof LlmUsageRepository }
    ).LlmUsageRepository as typeof LlmUsageRepository;
  } catch {
    throw new Error(
      'Could not import @spatula/db — run `pnpm install` and ensure packages are built.',
    );
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required. Export it before running the sizing harness.');
  }

  const db = createDb(dbUrl);
  const usageRepo = new LlmUsageRepository(db);

  // Record start time
  const startMs = Date.now();
  const sinceDate = new Date(startMs - 1000); // 1s buffer before crawl start

  // ------------------------------------------------------------------
  // Crawl invocation
  //
  // The project's production crawl path is BullMQ-queued (CrawlWorker).
  // For a self-contained benchmark harness we use LocalPipelineRunner
  // (in-process, no Redis required) with a minimal JobConfig.
  //
  // Import is dynamic/lazy to avoid requiring Redis when gate is unset.
  // ------------------------------------------------------------------
  let LocalPipelineRunner: new (opts: {
    tenantId: string;
    usageRecorder?: unknown;
  }) => {
    run: (config: unknown) => Promise<{ pagesCompleted: number; status: string }>;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const coreMod = await import('@spatula/core');
    LocalPipelineRunner = (coreMod as { LocalPipelineRunner?: typeof LocalPipelineRunner })
      .LocalPipelineRunner as typeof LocalPipelineRunner;
  } catch {
    throw new Error(
      'Could not import @spatula/core — run `pnpm install` and ensure packages are built.',
    );
  }

  const jobConfig = {
    seedUrls: [SEED_URL],
    schema: {
      mode: 'discovery' as const,
      evolutionConfig: { enabled: false, batchSize: 10, maxFields: 50 },
    },
    crawl: {
      maxDepth: 3,
      maxPages: TARGET_PAGES,
      concurrency: 5,
      crawlerType: 'playwright' as const,
    },
    llm: {
      primaryModel: tier.model,
    },
  };

  const runner = new LocalPipelineRunner({ tenantId: TENANT_ID });

  log('Crawl starting…');
  const result = await runner.run(jobConfig);
  const endMs = Date.now();
  const wallClockMs = endMs - startMs;

  log(`Crawl finished. Status: ${result.status}, pages: ${result.pagesCompleted}`);
  log(`Wall-clock: ${formatDuration(wallClockMs)}`);

  // Fetch cost from usage DB
  const aggregation = await usageRepo.aggregateByTenant(TENANT_ID, sinceDate);
  const totalCostUsd = aggregation.totalCostUsd;
  const pagesCompleted = result.pagesCompleted > 0 ? result.pagesCompleted : 1;
  const costPerPageUsd = totalCostUsd / pagesCompleted;

  log(`Total LLM cost: ${formatCost(totalCostUsd)}`);
  log(`Cost/page: ${formatCost(costPerPageUsd)}`);

  return {
    tier: tier.name,
    model: tier.model,
    pages: result.pagesCompleted,
    wallClockMs,
    wallClockFormatted: formatDuration(wallClockMs),
    totalCostUsd,
    costPerPageUsd,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('=== Spatula Hardware-Sizing Baseline ===');
  // eslint-disable-next-line no-console
  console.log(`Tiers: fast / primary / smart | Pages/tier: ${TARGET_PAGES} | Seed: ${SEED_URL}`);
  // eslint-disable-next-line no-console
  console.log('WARNING: This harness incurs real LLM cost via OpenRouter.\n');

  const results: TierResult[] = [];
  const errors: Array<{ tier: string; error: string }> = [];

  for (const tier of TIERS) {
    try {
      const result = await runTier(tier);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[${tier.name}] FAILED: ${msg}`);
      errors.push({ tier: tier.name, error: msg });
    }
  }

  // Print Markdown table
  if (results.length > 0) {
    printMarkdownTable(results);
  }

  // Write machine-readable JSON results artifact
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, '.sizing-results.json');
  const artifact = {
    generatedAt: new Date().toISOString(),
    targetVm: 'Hetzner CX32 (4 vCPU / 8 GB RAM / 80 GB SSD NVMe)',
    seedUrl: SEED_URL,
    targetPages: TARGET_PAGES,
    results,
    errors,
  };
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Results written to: ${outPath}`);

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n${errors.length} tier(s) failed. See above for details.`);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
