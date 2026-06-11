/**
 * scripts/sizing-baseline.ts
 *
 * DEPLOY-09: Hardware-sizing baseline harness (API + worker / Postgres path).
 *
 * Runs a TARGET_PAGES crawl ONCE PER routing tier (fast / primary / smart) against
 * a RUNNING Spatula stack and records wall-clock + LLM cost-per-page. Results are
 * emitted as a Markdown table to stdout and written to scripts/.sizing-results.json
 * so the docs/runbooks/hardware-sizing.md table can be filled from them.
 *
 * == Why the API/worker path ==
 * This harness drives the REAL production crawl path: it submits a job per tier via
 * the HTTP API, the BullMQ CrawlWorker processes it, and LLM usage is recorded to
 * Postgres by the worker's usage-recorder. The harness then reads the per-job cost
 * (LlmUsageRepository.aggregateByTenant → byJob) and the page count
 * (CrawlTaskRepository.getJobStats → completed) directly from Postgres.
 *
 * NOTE: the page count is NOT exposed over HTTP for this path (the API/worker path
 * never writes task counts into jobs.stats — only the local SQLite runner does), so
 * the harness needs DATABASE_URL to read pages + cost. It runs on the same VM as the
 * stack (docker-compose.prod.yml) where Postgres is reachable.
 *
 * == Required running stack ==
 *   API + worker + Redis + Postgres (e.g. `docker compose -f docker-compose.prod.yml up`).
 *   The API/worker MUST have OPENROUTER_API_KEY set (the worker makes the LLM calls,
 *   not this harness). AUTH_STRATEGY=none is assumed (harness sends X-Tenant-Id).
 *
 * == Target hardware (D-01) ==
 * Hetzner CX32  —  4 vCPU / 8 GB RAM / 80 GB SSD NVMe / AMD EPYC (amd64)
 * Substitute your own VM class and note it in hardware-sizing.md; results vary by
 * hardware, network, and target site.
 *
 * == Routing tiers (D-02) ==
 * fast    — deepseek/deepseek-v4-flash  (cheapest, high-throughput)
 * primary — deepseek/deepseek-v4-pro    (balanced — production default)
 * smart   — google/gemini-3.5-flash     (highest quality)
 * Each tier pins ALL llm calls to one model via llm.primaryModel with no overrides,
 * producing a clean per-tier cost/page number.
 *
 * == Re-run instructions ==
 * See docs/runbooks/hardware-sizing.md. Typical invocation on the VM:
 *   SPATULA_LIVE_LLM=1 \
 *   SPATULA_API_URL=http://localhost:3000 \
 *   DATABASE_URL=postgresql://spatula:pass@localhost:5432/spatula \
 *   pnpm sizing:baseline
 *
 * Results vary by: target site structure, network latency, VM I/O, model pricing.
 */

// ============================================================
// LIVE GATE — must be first executable line
// ============================================================
if (process.env.SPATULA_LIVE_LLM !== '1') {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to run: set SPATULA_LIVE_LLM=1 to confirm this run will incur real LLM cost.\n' +
      'Use: SPATULA_LIVE_LLM=1 pnpm sizing:baseline\n' +
      '  or run via: pnpm sizing:baseline  (the package.json script sets the gate automatically)',
  );
  process.exit(2);
}

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// @spatula/db is imported DYNAMICALLY inside main() (after the gate) so the live
// gate above is the first thing that runs — a static ESM import is hoisted and
// would resolve/execute the workspace graph before the gate. A non-literal
// specifier keeps TS from static-resolving it (the module is present at runtime
// after `pnpm build`). Minimal structural types below describe what we use.
interface TaskStats {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}
interface UsageAggregation {
  totalCostUsd: number;
  byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
}
interface CrawlTaskRepoLike {
  getJobStats(jobId: string, tenantId: string): Promise<TaskStats>;
}
interface LlmUsageRepoLike {
  aggregateByTenant(tenantId: string, since: Date): Promise<UsageAggregation>;
}
interface DbModule {
  createDatabase: (url: string) => unknown;
  CrawlTaskRepository: new (db: unknown) => CrawlTaskRepoLike;
  LlmUsageRepository: new (db: unknown) => LlmUsageRepoLike;
}

// ============================================================
// Tier definitions (D-02)
// ============================================================
interface TierConfig {
  name: 'fast' | 'primary' | 'smart';
  model: string;
  description: string;
}

const TIERS: TierConfig[] = [
  { name: 'fast', model: 'deepseek/deepseek-v4-flash', description: 'Cheap, high-throughput' },
  { name: 'primary', model: 'deepseek/deepseek-v4-pro', description: 'Balanced — production default' },
  { name: 'smart', model: 'google/gemini-3.5-flash', description: 'Highest quality' },
];

// ============================================================
// Configuration (overridable via env)
// ============================================================
const API_URL = (process.env.SPATULA_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL;
const TARGET_PAGES = parseInt(process.env.SIZING_PAGES ?? '1000', 10);
const SEED_URL = process.env.SIZING_SEED_URL ?? 'https://quotes.toscrape.com/';
const MAX_DEPTH = parseInt(process.env.SIZING_MAX_DEPTH ?? '20', 10);
const CONCURRENCY = parseInt(process.env.SIZING_CONCURRENCY ?? '5', 10);
const CRAWLER_TYPE = (process.env.SIZING_CRAWLER ?? 'playwright') as 'playwright' | 'firecrawl';
const CREATION_SECRET = process.env.TENANT_CREATION_SECRET;
const POLL_MS = parseInt(process.env.SIZING_POLL_MS ?? '10000', 10);
const MAX_WAIT_MS = parseInt(process.env.SIZING_MAX_WAIT_MS ?? String(2 * 60 * 60 * 1000), 10);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// ============================================================
// Result types
// ============================================================
interface TierResult {
  tier: 'fast' | 'primary' | 'smart';
  model: string;
  jobId: string;
  jobStatus: string;
  pages: number;
  wallClockMs: number;
  wallClockFormatted: string;
  totalCostUsd: number;
  costPerPageUsd: number;
}

// ============================================================
// Helpers
// ============================================================
/* eslint-disable no-console */
const log = (...a: unknown[]) => console.log(...a);

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; tenantId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.tenantId) headers['x-tenant-id'] = opts.tenantId;
  if (CREATION_SECRET && path === '/api/v1/tenants') headers['x-creation-secret'] = CREATION_SECRET;
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function printMarkdownTable(results: TierResult[]): void {
  log('\n## Sizing Baseline Results\n');
  log('Target VM: Hetzner CX32 (4 vCPU / 8 GB RAM / 80 GB SSD NVMe)');
  log(`Seed URL:  ${SEED_URL}`);
  log(`Pages/tier (target ${TARGET_PAGES}, actual = crawl tasks completed)\n`);
  log('| Tier    | Model                        | Pages | Wall-clock | Total LLM cost | LLM cost/page |');
  log('| ------- | ---------------------------- | ----- | ---------- | -------------- | ------------- |');
  for (const r of results) {
    log(
      `| ${r.tier.padEnd(7)} | ${r.model.padEnd(28)} | ${String(r.pages).padEnd(5)} | ${r.wallClockFormatted.padEnd(10)} | ${formatCost(r.totalCostUsd).padEnd(14)} | ${formatCost(r.costPerPageUsd).padEnd(13)} |`,
    );
  }
  log('');
}

// ============================================================
// Per-tier run
// ============================================================
async function runTier(
  tier: TierConfig,
  ctx: { tenantId: string; taskRepo: CrawlTaskRepoLike; usageRepo: LlmUsageRepoLike },
): Promise<TierResult> {
  const tlog = (...a: unknown[]) => log(`[${tier.name}]`, ...a);
  tlog(`Submitting ${TARGET_PAGES}-page crawl pinned to ${tier.model} (seed: ${SEED_URL})`);

  const startMs = Date.now();
  const since = new Date(startMs - 1000); // 1s buffer before submit

  // 1. Submit the job (tier pinned via llm.primaryModel, no overrides → all calls use it)
  const created = await api<{ data: { id: string } }>('/api/v1/jobs', {
    method: 'POST',
    tenantId: ctx.tenantId,
    body: {
      name: `sizing-${tier.name}`,
      description: `Hardware-sizing baseline run for the ${tier.name} tier (${tier.model}).`,
      seedUrls: [SEED_URL],
      crawl: {
        maxDepth: MAX_DEPTH,
        maxPages: TARGET_PAGES,
        concurrency: CONCURRENCY,
        crawlerType: CRAWLER_TYPE,
      },
      schema: { mode: 'discovery', evolutionConfig: { enabled: false } },
      llm: { primaryModel: tier.model, modelOverrides: {} },
    },
  });
  const jobId = created.data.id;
  tlog(`Job ${jobId} created — starting…`);

  // 2. Start the crawl
  await api(`/api/v1/jobs/${jobId}/start`, { method: 'POST', tenantId: ctx.tenantId });

  // 3. Poll until terminal
  let status = 'pending';
  const deadline = startMs + MAX_WAIT_MS;
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) {
      tlog(`TIMEOUT after ${formatDuration(MAX_WAIT_MS)} (last status: ${status})`);
      break;
    }
    await sleep(POLL_MS);
    const job = await api<{ data: { status: string } }>(`/api/v1/jobs/${jobId}`, {
      tenantId: ctx.tenantId,
    });
    if (job.data.status !== status) {
      status = job.data.status;
      tlog(`status → ${status}`);
    }
  }

  const wallClockMs = Date.now() - startMs;

  // 4. Read pages (completed crawl tasks) + cost (per-job LLM usage) from Postgres
  const taskStats = await ctx.taskRepo.getJobStats(jobId, ctx.tenantId);
  const pages = taskStats.completed;
  const agg = await ctx.usageRepo.aggregateByTenant(ctx.tenantId, since);
  const totalCostUsd = agg.byJob.find((j) => j.jobId === jobId)?.costUsd ?? 0;
  const costPerPageUsd = totalCostUsd / Math.max(pages, 1);

  tlog(
    `done: status=${status} pages=${pages} wall=${formatDuration(wallClockMs)} cost=${formatCost(totalCostUsd)} cost/page=${formatCost(costPerPageUsd)}`,
  );

  return {
    tier: tier.name,
    model: tier.model,
    jobId,
    jobStatus: status,
    pages,
    wallClockMs,
    wallClockFormatted: formatDuration(wallClockMs),
    totalCostUsd,
    costPerPageUsd,
  };
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
  log('=== Spatula Hardware-Sizing Baseline (API + worker path) ===');
  log(`API: ${API_URL} | Tiers: fast/primary/smart | Pages/tier: ${TARGET_PAGES} | Seed: ${SEED_URL}`);
  log('WARNING: the running stack will incur real LLM cost via OpenRouter.\n');

  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required (harness reads pages + cost from Postgres).');
    process.exit(2);
  }

  // Preflight: API reachable?
  try {
    await api('/health');
  } catch (err) {
    console.error(`API not reachable at ${API_URL}/health — is the stack up? ${String(err)}`);
    process.exit(1);
  }

  // Dynamic import (after the gate) — non-literal specifier keeps TS from
  // static-resolving the workspace module; present at runtime after `pnpm build`.
  const dbSpecifier = '@spatula/db';
  let dbMod: DbModule;
  try {
    dbMod = (await import(dbSpecifier)) as unknown as DbModule;
  } catch (err) {
    console.error(
      `Could not import @spatula/db — run \`pnpm install && pnpm build\` first. ${String(err)}`,
    );
    process.exit(1);
  }
  const db = dbMod.createDatabase(DATABASE_URL);
  const taskRepo = new dbMod.CrawlTaskRepository(db);
  const usageRepo = new dbMod.LlmUsageRepository(db);

  // One tenant for the whole run; per-tier jobs isolate cost via byJob[jobId].
  const tenantResp = await api<{ data: { id: string } }>('/api/v1/tenants', {
    method: 'POST',
    body: { name: 'sizing-baseline' },
  });
  const tenantId = tenantResp.data.id;
  log(`Tenant: ${tenantId}\n`);

  const results: TierResult[] = [];
  const errors: Array<{ tier: string; error: string }> = [];
  for (const tier of TIERS) {
    try {
      results.push(await runTier(tier, { tenantId, taskRepo, usageRepo }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${tier.name}] FAILED: ${msg}`);
      errors.push({ tier: tier.name, error: msg });
    }
  }

  if (results.length > 0) printMarkdownTable(results);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, '.sizing-results.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targetVm: 'Hetzner CX32 (4 vCPU / 8 GB RAM / 80 GB SSD NVMe)',
        apiUrl: API_URL,
        seedUrl: SEED_URL,
        targetPages: TARGET_PAGES,
        tenantId,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  log(`Results written to: ${outPath}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} tier(s) failed. See above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
/* eslint-enable no-console */
