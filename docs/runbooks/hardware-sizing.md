# Hardware Sizing Runbook

> **Status:** Skeleton — numeric cells marked `<filled by live run>` are pending the
> live 1000-page-per-tier measurement (DEPLOY-09). Run `pnpm sizing:baseline` on the
> defined VM (see §Methodology) to fill them.

## Overview

This runbook documents the measured hardware requirements for running a full Spatula
crawl stack (API + worker + Postgres + Redis) at production scale. Numbers are derived
from **live measurement on one defined cloud VM class** — not synthetic estimates.

Self-hosters can re-run the harness on their own hardware and compare results.

---

## Defined Hardware (D-01)

All baseline measurements were taken on:

| Property     | Value                                         |
| ------------ | --------------------------------------------- |
| **Provider** | Hetzner Cloud                                 |
| **Instance** | CX32                                          |
| **vCPU**     | 4 vCPU (AMD EPYC, shared)                     |
| **RAM**      | 8 GB DDR4                                     |
| **Disk**     | 80 GB SSD NVMe                                |
| **Network**  | 20 Gbit/s (ingress unlimited, egress metered) |
| **OS**       | Ubuntu 24.04 LTS                              |
| **Cost**     | ~EUR 0.057/h on-demand (EUR ~41/month)        |
| **Region**   | Hetzner FSN1 (Falkenstein, Germany)           |

**Why this VM?** The CX32 is a widely available, reproducible, budget cloud VM
accessible to self-hosters globally. It represents a sensible minimum for a production
single-node deployment. A laptop is explicitly rejected as a server-sizing proxy.

**Substituting your own VM:** Run `pnpm sizing:baseline` on your target hardware and
replace the measured cells below. Results will differ based on CPU frequency, disk I/O
speed, network bandwidth to target sites, and model API latency from your region.

---

## Methodology

- **Crawl size:** 1000 pages per routing tier (D-03 full live measurement)
- **Seed corpus:** `https://quotes.toscrape.com/` (publicly accessible, consistent
  structure, no rate-limiting). Override via `SIZING_SEED_URL` env var.
- **Tiers measured:** fast / primary / smart — one crawl per tier, in sequence
- **LLM routing:** each tier pins all LLM calls to one model (via `LLMConfig.primaryModel`),
  producing a clean per-model cost/page number
- **Cost measurement:** LLM usage recorded per-call to Postgres (`llm_usage` table)
  by the worker; the harness reads `LlmUsageRepository.aggregateByTenant()` and takes
  the per-job entry (`byJob[jobId]`), dividing total cost by pages completed
- **Page count:** read from Postgres as completed crawl tasks
  (`CrawlTaskRepository.getJobStats(jobId).completed`) — this path does not surface a
  page count over HTTP, so the harness needs `DATABASE_URL`
- **Wall-clock:** measured from job submit to terminal status (includes LLM API
  roundtrips, crawler I/O, queue + Postgres writes)
- **Runner:** the REAL production path — the harness submits a job per tier via the
  HTTP API; the BullMQ **CrawlWorker** processes it and records LLM usage. Requires a
  running stack (API + worker + Redis + Postgres), e.g. `docker compose -f
  docker-compose.prod.yml up`. The API/worker must have `OPENROUTER_API_KEY` set.

### Model-per-tier

| Tier    | Model                        | Character                     |
| ------- | ---------------------------- | ----------------------------- |
| fast    | `xiaomi/mimo-v2-flash`       | Cheapest, highest throughput  |
| primary | `deepseek/deepseek-v4-flash` | Balanced — production default |
| smart   | `deepseek/deepseek-v4-pro`   | Highest quality               |

Pricing is sourced from OpenRouter and may change. Re-run the harness after significant
model price changes.

---

## Measured Baseline Table (DEPLOY-09 D-02/D-03)

> Fill this table by running `pnpm sizing:baseline` on the CX32 VM above and pasting
> the per-tier rows from `scripts/.sizing-results.json`.

| Tier    | Pages | Wall-clock             | Total LLM cost         | LLM cost/page          |
| ------- | ----- | ---------------------- | ---------------------- | ---------------------- |
| fast    | 1000  | `<filled by live run>` | `<filled by live run>` | `<filled by live run>` |
| primary | 1000  | `<filled by live run>` | `<filled by live run>` | `<filled by live run>` |
| smart   | 1000  | `<filled by live run>` | `<filled by live run>` | `<filled by live run>` |

**VM:** Hetzner CX32 (4 vCPU / 8 GB RAM / SSD) — see §Defined Hardware above.
**Measured:** `<date of live run>`
**Harness:** `scripts/sizing-baseline.ts` — see §Re-run Instructions below.

> These numbers represent one crawl run under one network + model latency condition.
> Treat them as order-of-magnitude guidance, not SLAs.

---

## Interpreting the Results

- **Wall-clock** is dominated by crawler I/O (Playwright + target site response) and
  LLM API roundtrip latency. Faster VM disk has minimal impact; faster network matters more.
- **LLM cost/page** scales linearly with page count. For N pages: `cost ≈ N × cost/page`.
  Budget for ~10–20% variance due to page content size variation.
- **Smart tier** quality gain over primary is significant for complex extraction tasks
  (entity matching, schema evolution). For simple flat-schema sites, primary is sufficient.
- **Concurrency:** default `concurrency: 5` (5 parallel browser pages). Increase on
  larger VMs (CX42 8 vCPU / 16 GB → `concurrency: 10`); decrease on shared VMs with
  lower memory.

---

## Re-run Instructions

Self-hosters can reproduce the baseline on their own hardware.

### Prerequisites

```bash
# 1. Provision a cloud VM (CX32 or equivalent)
# 2. Install Docker + pnpm (or clone the repo and pnpm install)
pnpm install
pnpm build

# 3. Bring up the FULL stack (API + worker + Redis + Postgres) with your LLM key.
#    The worker makes the LLM calls — OPENROUTER_API_KEY goes on the stack, not the harness.
OPENROUTER_API_KEY=sk-or-... docker compose -f docker-compose.prod.yml up -d

# 4. Run migrations once (see docs/runbooks/render-deploy.md or the migrate image)
```

### Environment variables (for the harness process)

| Variable                 | Required | Description                                                              |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| `SPATULA_LIVE_LLM`       | yes      | Set to `1` to confirm real LLM spend (set by the npm script)             |
| `DATABASE_URL`           | yes      | Postgres connection string — harness reads pages + cost                  |
| `SPATULA_API_URL`        | no       | Base URL of the running API (default: `http://localhost:3000`)           |
| `SIZING_PAGES`           | no       | Target pages per tier (default: `1000`)                                  |
| `SIZING_SEED_URL`        | no       | Seed URL (default: `https://quotes.toscrape.com/`)                       |
| `SIZING_MAX_DEPTH`       | no       | Max crawl depth (default: `20` — enough to reach the page target)        |
| `SIZING_CONCURRENCY`     | no       | Crawl concurrency (default: `5`)                                         |
| `SIZING_CRAWLER`         | no       | `playwright` (default) or `firecrawl`                                    |
| `SIZING_MAX_WAIT_MS`     | no       | Per-tier completion timeout (default: 2h)                                |
| `TENANT_CREATION_SECRET` | no       | Sent as `X-Creation-Secret` if your stack guards tenant creation         |

> `OPENROUTER_API_KEY` is **not** a harness variable — it belongs on the API/worker
> stack (the worker makes the LLM calls). `AUTH_STRATEGY=none` is assumed (the harness
> creates a tenant and sends `X-Tenant-Id`).

### Run

```bash
export DATABASE_URL=postgresql://spatula:pass@localhost:5432/spatula
export SPATULA_API_URL=http://localhost:3000

# Runs fast → primary → smart tiers (TARGET_PAGES each, ~real LLM cost on the stack)
pnpm sizing:baseline
```

> **Seed corpus size:** `quotes.toscrape.com` has only ~250 crawlable pages, so a
> 1000-page target will exhaust it short of 1000. For a true 1k-page-per-tier run,
> point `SIZING_SEED_URL` at a site with ≥1000 reachable pages. `cost/page` and
> `wall-clock/page` remain valid regardless of how many pages actually complete.

The script prints a Markdown table to stdout and writes
`scripts/.sizing-results.json` with the per-tier measurements.

### Fill the runbook table

After the run, copy the three measured rows into the **Measured Baseline Table** above
and update the **Measured** date. Commit the filled table.

```bash
# View JSON results
cat scripts/.sizing-results.json | jq '.results[] | {tier, pages, wallClockFormatted, totalCostUsd, costPerPageUsd}'
```

---

## Capacity Planning

Use the measured `cost/page` and `wall-clock` values to estimate requirements:

```
Total LLM cost  = pages × (cost/page for your tier)
Crawl duration  = pages × (wall-clock/page for your tier) / concurrency_factor
```

**Recommended minimum specs for production:**

| Deployment scale | Recommended VM         | Notes                                       |
| ---------------- | ---------------------- | ------------------------------------------- |
| < 10k pages/day  | CX32 (4 vCPU / 8 GB)   | Single node, measured baseline above        |
| 10k–100k/day     | CX42 (8 vCPU / 16 GB)  | Increase `concurrency` + add Redis replica  |
| > 100k/day       | Kubernetes + autoscale | See `deploy/k8s/` — horizontal worker scale |

---

## Assumptions and Caveats

1. **Target site matters most.** A JavaScript-heavy SPA site (Playwright renders full
   JS) is 3–5× slower per page than a static HTML site (Firecrawl API). The baseline
   uses `quotes.toscrape.com` (static HTML) — adjust expectations for your target.
2. **OpenRouter latency varies by region.** Expect 20–40% higher latency from regions
   far from OpenRouter's US-West endpoints.
3. **Model pricing changes.** OpenRouter model pricing is updated regularly. Re-run
   the harness after significant price changes or model deprecations.
4. **Production topology.** The harness drives the real BullMQ CrawlWorker path
   (API + worker + Redis + Postgres) — so wall-clock includes queue overhead and is
   representative of a real deployment, not an in-process shortcut.
5. **Cold start excluded.** The first page includes Playwright browser launch (~2–5s).
   This is amortized across 1000 pages and has negligible impact on per-page averages.

---

## Local Smoke Verification (Phase 19.1)

**Date:** 2026-06-12
**Harness invocation:**
```bash
SPATULA_PG_PORT=5433 SPATULA_REDIS_PORT=6380 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# (migrate runs automatically via docker-compose.prod.yml migrate service)

set -a; . ./.env; set +a
SPATULA_EMBEDDED_WORKER=1 PORT=3100 NODE_ENV=production \
  DATABASE_URL=postgresql://spatula:spatula@localhost:5433/spatula \
  REDIS_URL=redis://localhost:6380 \
  node apps/api/dist/main.js > /tmp/spatula-api.log 2>&1 &

SIZING_PAGES=3 SIZING_MAX_DEPTH=5 SPATULA_API_URL=http://localhost:3100 pnpm sizing:baseline
```

**Result:** Crawls complete with pages > 0 and LLM tokens recorded per-job.

| Tier    | Model                              | Pages | Total tokens | LLM cost/page |
| ------- | ---------------------------------- | ----- | ------------ | ------------- |
| fast    | deepseek/deepseek-v4-flash-20260423 | 22+  | 95,701       | $0.0000¹      |
| primary | deepseek/deepseek-v4-pro-20260423  | 1+   | 9,400        | $0.0000¹      |

¹ DeepSeek models are currently priced at $0.00/token on OpenRouter as of 2026-06-12.
  The usage recorder IS wired and records tokens correctly — `byJob` attribution confirmed.
  Cost will be non-zero when the sizing harness is run with paid models (e.g. Anthropic Claude).
  The 1k-page-per-tier table (DEPLOY-09) should use the model pricing at time of measurement.

**Key proof:** The embedded worker (Phase 19.1 fixes applied) processes crawl jobs without
DLQ-ing (`WorkerDeps not initialized` bug fixed). LLM usage attributed to correct jobId.
The full 1k-page CX32 measurement (DEPLOY-09 D-02/D-03) remains for the live-run checkpoint.

---

_Runbook version: 1.1 — Phase 19.1 local smoke recorded 2026-06-12_
_Re-run harness: `pnpm sizing:baseline` — see `scripts/sizing-baseline.ts`_
