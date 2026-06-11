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
- **Cost measurement:** LLM usage recorded per-call to Postgres (`llm_usage` table);
  harness reads `aggregateByTenant()` after each crawl and divides by pages completed
- **Wall-clock:** measured from crawl start to last page completion (includes LLM API
  roundtrips, crawler I/O, Postgres writes)
- **Runner:** `LocalPipelineRunner` (in-process, no Redis required for standalone
  measurement; substitute BullMQ worker topology for queue-based production runs)

### Model-per-tier

| Tier    | Model                        | Character                     |
| ------- | ---------------------------- | ----------------------------- |
| fast    | `deepseek/deepseek-v4-flash` | Cheapest, highest throughput  |
| primary | `deepseek/deepseek-v4-pro`   | Balanced — production default |
| smart   | `google/gemini-3.5-flash`    | Highest quality               |

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
# 3. Start Postgres + Redis (docker compose up -d postgres redis)
pnpm install
pnpm build
```

### Environment variables

| Variable             | Required | Description                                                       |
| -------------------- | -------- | ----------------------------------------------------------------- |
| `SPATULA_LIVE_LLM`   | yes      | Set to `1` to confirm real LLM spend (set by npm script)          |
| `OPENROUTER_API_KEY` | yes      | Your OpenRouter API key                                           |
| `DATABASE_URL`       | yes      | Postgres connection string (e.g., `postgresql://...`)             |
| `SIZING_PAGES`       | no       | Pages per tier (default: `1000`)                                  |
| `SIZING_SEED_URL`    | no       | Seed URL (default: `https://quotes.toscrape.com/`)                |
| `SIZING_TENANT_ID`   | no       | Tenant ID for usage recording (default: `sizing-baseline-tenant`) |

### Run

```bash
export OPENROUTER_API_KEY=sk-or-...
export DATABASE_URL=postgresql://spatula:pass@localhost:5432/spatula

# Runs fast → primary → smart tiers (1000 pages each, ~real LLM cost)
pnpm sizing:baseline
```

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
4. **No Redis in baseline.** The harness uses `LocalPipelineRunner` (in-process queue).
   A production BullMQ topology adds ~5–10% overhead but enables horizontal scaling.
5. **Cold start excluded.** The first page includes Playwright browser launch (~2–5s).
   This is amortized across 1000 pages and has negligible impact on per-page averages.

---

_Runbook version: 1.0 — created Phase 19, Plan 09 (DEPLOY-09)_
_Re-run harness: `pnpm sizing:baseline` — see `scripts/sizing-baseline.ts`_
