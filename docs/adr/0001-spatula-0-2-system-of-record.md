# 0001. Spatula 0.2: a system of record for living web data

- Status: accepted by the owner, 2026-10-09
- Date: 2026-10-09

## Context

Spatula 0.1 is a pipeline for one-off pulls. It crawls, extracts with an LLM, reconciles, and
exports, on a Node server or as a SQLite CLI. It never re-fetches a page, it regenerates every ID
on every run, it throws away JSON-LD, and by default it merges nothing. Its catalog-publication
engine (stable IDs, provenance for each field, generations, gated publishing) is sound, but
nothing calls it.

Getting data off the web is crowded and well funded: search, crawling, extraction, and page
monitoring are commodities. What nobody owns is the layer between those services and the app
that depends on the data:

- identities that stay stable across sources and refreshes;
- a history of every value and where it came from;
- review that the system learns from;
- versioned publishing that the app acknowledges.

Spatula's first user is Crowdio, the owner's gear app. Its catalog and prices have to stay true.

## Decision

Spatula 0.2 is a system of record for living web data. Its promise: "Spatula keeps the external
data your app depends on true, and can show why."

- **What it owns:** identity, truth (every value as a statement, with its source and history),
  judgement, freshness, policy, publication, and measured accuracy.
- **What stays thin:** fetching and extraction. They're honest, and they try structured data
  before an LLM.
- **What suppliers do:** browser rendering, search, and hard pages, through adapters. Their
  answers are evidence like any other.
- **Where it runs:** serverless, on Cloudflare, in the owner's account:
  - an API Worker (Hono);
  - a Refresh Workflow for each run;
  - a HostGate Durable Object for each host;
  - R2 for raw pages and snapshots;
  - Postgres through Hyperdrive, as the system of record;
  - AI Gateway in front of LLMs.
- **Packages:** `@spatula/core` (no Cloudflare imports), `@spatula/pack-products`,
  `@spatula/store`, `@spatula/worker`, and `@spatula/cli`.
  - The new code lives in `platform/` and `packs/`.
  - The 0.1 packages are frozen. One commit removes them once 0.2 runs end to end.
- **Honest collection:**
  - Spatula names itself in its user agent and follows robots.txt (RFC 9309) for its product
    token, `Spatula`.
  - It honors Crawl-delay and Content Signals.
  - It requests each host at most once a second, and backs off on 429 and 5xx.
  - It records a block and never works around one: no stealth, proxies, or CAPTCHA solving.
- **Order of work:** in slices, each verified by Crowdio. Slice 0 is a walking skeleton: one
  dataset of known pages, from fetch to a published snapshot.

## Consequences

- 0.2.0 breaks compatibility with 0.1. There are no compatibility promises before 1.0.
- A deployment needs a Postgres that Hyperdrive can reach.
- Rules live in `core` and run in Node tests; the Worker only wires them to Cloudflare. Leaving
  Cloudflare means replacing the Worker, not the rules or the data.

## Update, 2026-10-18 (ADR 0006)

- ADR 0006, "Refusals and routes", narrows "never works around one". Stated rules (robots.txt,
  terms, Content Signals, a 402) are never crossed, by any route. A challenge may one day be met by
  an intermediary, only for a source that opts in and only while Spatula is unverified. Spatula
  has no such route yet.
