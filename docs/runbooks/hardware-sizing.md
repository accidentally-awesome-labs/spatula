# Hardware Sizing Runbook

Spatula does not publish official production capacity numbers for a hosted deployment.
Self-hosters should measure their own target stack because crawl speed and cost are
dominated by target-site latency, JavaScript rendering requirements, LLM provider
latency, selected models, and allowed concurrency.

This runbook documents the first-party measurement harness and the assumptions needed
to produce repeatable local or cloud sizing data.

## What The Harness Measures

`pnpm sizing:baseline` drives the real server path:

- API server
- BullMQ worker
- PostgreSQL
- Redis
- configured crawler (`playwright` or `firecrawl`)
- configured LLM provider

The harness submits one job per routing tier and reads results through the public API.
It records:

- pages completed
- wall-clock time
- total LLM tokens
- total LLM cost, when provider pricing is available
- cost per completed page

The output is printed as a Markdown table and written to
`scripts/.sizing-results.json`.

## Recommended Test Environment

Use the same shape of infrastructure you expect to operate:

| Property | Recommendation                                                           |
| -------- | ------------------------------------------------------------------------ |
| CPU/RAM  | Start with at least 4 vCPU / 8 GB RAM for a single-node smoke            |
| Disk     | SSD-backed Postgres volume                                               |
| Network  | Same cloud region or network path expected in production                 |
| OS       | A supported Linux distribution from `docs/support-matrix.md`             |
| Runtime  | Node, pnpm, PostgreSQL, and Redis versions from `docs/support-matrix.md` |

Avoid using a laptop run as a production sizing proxy. Laptop CPU governors, local
network paths, and browser cache state make results difficult to compare.

## Prerequisites

```bash
pnpm install
pnpm build
```

Start the full stack with your normal environment:

```bash
OPENROUTER_API_KEY=sk-or-... docker compose -f docker-compose.prod.yml up -d
```

The worker makes the LLM calls, so provider credentials belong on the API/worker
stack. The harness itself only needs API access.

## Harness Environment

| Variable                 | Required | Default                        | Description                                               |
| ------------------------ | -------- | ------------------------------ | --------------------------------------------------------- |
| `SPATULA_LIVE_LLM`       | yes      | set by `pnpm sizing:baseline`  | Confirms live LLM spend                                   |
| `SPATULA_API_URL`        | no       | `http://localhost:3000`        | Running API base URL                                      |
| `SIZING_PAGES`           | no       | `1000`                         | Target pages per tier                                     |
| `SIZING_SEED_URL`        | no       | `https://quotes.toscrape.com/` | Seed URL to crawl                                         |
| `SIZING_MAX_DEPTH`       | no       | `20`                           | Crawl depth cap                                           |
| `SIZING_CONCURRENCY`     | no       | `5`                            | Crawl concurrency                                         |
| `SIZING_CRAWLER`         | no       | `playwright`                   | `playwright` or `firecrawl`                               |
| `SIZING_MAX_WAIT_MS`     | no       | `7200000`                      | Per-tier completion timeout                               |
| `TENANT_CREATION_SECRET` | no       | unset                          | Sent as `X-Creation-Secret` if tenant creation is guarded |

## Run

```bash
export SPATULA_API_URL=http://localhost:3000
pnpm sizing:baseline
```

For a quick smoke run:

```bash
SIZING_PAGES=3 SIZING_MAX_DEPTH=5 pnpm sizing:baseline
```

## Interpreting Results

- Compare runs only when the seed URL, page target, crawler, model selection, and
  concurrency are the same.
- `quotes.toscrape.com` is useful for repeatable smoke tests but is too small for a
  true 1000-page crawl. Use a site you are allowed to crawl with enough reachable
  pages for larger measurements.
- Playwright-heavy JavaScript sites are usually slower than static HTML sites.
- LLM cost scales with page content size, schema complexity, and selected models.
- Re-run measurements after changing crawler type, model routing, concurrency,
  cloud region, or target-site class.

## Capacity Planning Template

After a measurement run, use the generated values:

```text
Estimated LLM cost = target pages * measured cost/page
Estimated duration = target pages * measured wall-clock/page / concurrency factor
```

Treat the result as a planning estimate, not an SLA. Keep at least 20 percent headroom
for target-site variance, provider latency spikes, and retries.

## Verification

Before trusting a run:

1. Confirm the API health endpoint is ready.
2. Confirm workers are processing jobs and not writing unexpected DLQ entries.
3. Confirm `GET /api/v1/usage?period=1d` includes token usage for the measured jobs.
4. Confirm `scripts/.sizing-results.json` contains one result per measured tier.

Re-run the harness whenever provider pricing, model ids, deployment topology, or target
site class changes materially.
