/**
 * scripts/sizing-baseline.ts
 *
 * Hardware-sizing baseline harness (pure HTTP against a running stack).
 *
 * Runs a TARGET_PAGES crawl ONCE PER routing tier (fast / primary / smart) against
 * a RUNNING Spatula stack and records wall-clock + LLM cost-per-page. Results are
 * emitted as a Markdown table to stdout and written to scripts/.sizing-results.json
 * so the docs/runbooks/hardware-sizing.md table can be filled from them.
 *
 * == How it works (pure HTTP — no @spatula/* imports, no DB access) ==
 * Drives the REAL production crawl path entirely over HTTP: it submits a job per tier,
 * the BullMQ CrawlWorker processes it (and records LLM usage), then the harness reads:
 *   - pages  ← GET /api/v1/jobs/:id   → data.stats.pagesCompleted
 *   - cost   ← GET /api/v1/usage      → data.byJob[jobId].costUsd
 * Because it only needs an HTTP base URL, it runs anywhere — local, the VM, or a
 * remote deploy — without DATABASE_URL or workspace module resolution.
 *
 * == Required running stack ==
 *   API + worker + Redis + Postgres (e.g. `docker compose -f docker-compose.prod.yml up`
 *   for the API-side, plus a crawler the worker can use). The API/worker MUST have
 *   OPENROUTER_API_KEY set (the worker makes the LLM calls, not this harness).
 *   The worker also needs a working crawler: Firecrawl (FIRECRAWL_API_KEY) for the
 *   distroless worker image, OR a Playwright-capable worker (e.g. the embedded worker
 *   on a host/VM with Playwright installed). AUTH_STRATEGY=none assumed (sends X-Tenant-Id).
 *
 * == Recommended baseline hardware ==
 * Hetzner CX32  —  4 vCPU / 8 GB RAM / 80 GB SSD NVMe / AMD EPYC (amd64)
 * Substitute your own VM class and note it in hardware-sizing.md; results vary by
 * hardware, network, and target site.
 *
 * == Routing tiers ==
 * fast    — xiaomi/mimo-v2-flash        (cheapest, high-throughput)
 * primary — deepseek/deepseek-v4-flash  (balanced — production default)
 * smart   — deepseek/deepseek-v4-pro    (highest quality)
 * Each tier pins ALL llm calls to one model via llm.primaryModel with no overrides,
 * producing a clean per-tier cost/page number.
 *
 * == Re-run instructions ==
 * See docs/runbooks/hardware-sizing.md. Typical invocation:
 *   SPATULA_LIVE_LLM=1 SPATULA_API_URL=http://localhost:3000 pnpm sizing:baseline
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

// Pure-HTTP harness — NO @spatula/* imports, no direct DB access. Pages come from
// GET /jobs/:id (stats.pagesCompleted) and cost from GET /api/v1/usage (byJob).
// This keeps the harness portable (runs against any reachable Spatula stack,
// local or remote) and free of workspace ESM-resolution concerns.
interface JobDetail {
  data: { status: string; stats: Record<string, number> };
}
interface UsageResponse {
  data: { byJob: Array<{ jobId: string; tokens: number; costUsd: number }> };
}

// ============================================================
// Tier definitions
// ============================================================
interface TierConfig {
  name: 'fast' | 'primary' | 'smart';
  model: string;
  description: string;
}

const TIERS: TierConfig[] = [
  { name: 'fast', model: 'xiaomi/mimo-v2-flash', description: 'Cheap, high-throughput' },
  {
    name: 'primary',
    model: 'deepseek/deepseek-v4-flash',
    description: 'Balanced — production default',
  },
  { name: 'smart', model: 'deepseek/deepseek-v4-pro', description: 'Highest quality' },
];

// ============================================================
// Configuration (overridable via env)
// ============================================================
const API_URL = (process.env.SPATULA_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

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
  log(
    '| Tier    | Model                        | Pages | Wall-clock | Total LLM cost | LLM cost/page |',
  );
  log(
    '| ------- | ---------------------------- | ----- | ---------- | -------------- | ------------- |',
  );
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
async function runTier(tier: TierConfig, ctx: { tenantId: string }): Promise<TierResult> {
  const tlog = (...a: unknown[]) => log(`[${tier.name}]`, ...a);
  tlog(`Submitting ${TARGET_PAGES}-page crawl pinned to ${tier.model} (seed: ${SEED_URL})`);

  const startMs = Date.now();

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

  // 3. Poll until terminal (keep the last job detail — its stats carry pagesCompleted)
  let status = 'pending';
  let job: JobDetail | undefined;
  const deadline = startMs + MAX_WAIT_MS;
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) {
      tlog(`TIMEOUT after ${formatDuration(MAX_WAIT_MS)} (last status: ${status})`);
      break;
    }
    await sleep(POLL_MS);
    job = await api<JobDetail>(`/api/v1/jobs/${jobId}`, { tenantId: ctx.tenantId });
    if (job.data.status !== status) {
      status = job.data.status;
      tlog(`status → ${status}`);
    }
  }

  const wallClockMs = Date.now() - startMs;

  // 4. Read pages (GET /jobs/:id → stats.pagesCompleted) + cost (GET /usage → byJob)
  const pages = job?.data.stats?.pagesCompleted ?? 0;
  const usage = await api<UsageResponse>('/api/v1/usage?period=1d', { tenantId: ctx.tenantId });
  const totalCostUsd = usage.data.byJob.find((j) => j.jobId === jobId)?.costUsd ?? 0;
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
  log(
    `API: ${API_URL} | Tiers: fast/primary/smart | Pages/tier: ${TARGET_PAGES} | Seed: ${SEED_URL}`,
  );
  log('WARNING: the running stack will incur real LLM cost via OpenRouter.\n');

  // Preflight: API reachable?
  try {
    await api('/health');
  } catch (err) {
    console.error(`API not reachable at ${API_URL}/health — is the stack up? ${String(err)}`);
    process.exit(1);
  }

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
      results.push(await runTier(tier, { tenantId }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${tier.name}] FAILED: ${msg}`);
      errors.push({ tier: tier.name, error: msg });
    }
  }

  if (results.length > 0) printMarkdownTable(results);

  const { writeFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
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
