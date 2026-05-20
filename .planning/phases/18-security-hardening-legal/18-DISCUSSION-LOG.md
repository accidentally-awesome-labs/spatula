# Phase 18: Security Hardening & Legal - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 18-security-hardening-legal
**Areas discussed:** Legal identity path, Adversarial CI cadence, DSR tenant-delete model, Redaction strategy

---

## Legal Identity Path

### BLOCK-02 — entity vs interim name

| Option | Description | Selected |
|--------|-------------|----------|
| Interim — individual name | LICENSE `Copyright (c) 2026 Salar Sayyad`; NOTICE.md records future assignment | |
| Entity is formed | LICENSE `Copyright (c) 2026 Accidentally Awesome Labs`; no NOTICE.md | ✓ |

**User's choice:** Entity is formed.

### BLOCK-06 — USPTO TESS trademark search

| Option | Description | Selected |
|--------|-------------|----------|
| Done — conflict-free | Search complete; TRADEMARK.md just written as policy doc | |
| Fold search into phase | Phase 18 includes a task to run + document the TESS search before TRADEMARK.md finalized | ✓ |
| Proceed at risk | Write TRADEMARK.md now; search stays a Phase 22 gate | |

**User's choice:** Fold search into phase.

### BLOCK-09 — historical contributors

| Option | Description | Selected |
|--------|-------------|----------|
| Solo — just me | HISTORICAL_CONTRIBUTORS.md one-line enumeration; no outreach | ✓ |
| Others exist | Enumeration + pre-sign email outreach as tracked work | |

**User's choice:** Solo — just me.

---

## Adversarial CI Cadence

### Suite cadence

| Option | Description | Selected |
|--------|-------------|----------|
| PR-label + daily cron | Runs on PRs touching extraction/pinned-models (or live-llm label) + daily cron | ✓ |
| Daily cron only | One scheduled run/day; regression can sit undetected up to 24h | |
| Every push to main | Each main push + cron; fastest signal, highest cost | |

**User's choice:** PR-label + daily cron.

### Ollama lane in CI

| Option | Description | Selected |
|--------|-------------|----------|
| OpenRouter in CI, Ollama gated | CI cron runs OpenRouter pin; Ollama pin via manual workflow_dispatch / self-hosted | ✓ |
| Both in CI, model cached | Both pins run; Ollama model cached via actions/cache | |
| Both, fresh pull each run | Simplest config, pull 8B model fresh every run | |

**User's choice:** OpenRouter in CI, Ollama gated.

### Cron-failure handling

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-open a tracked issue | Failed cron opens/updates a labeled GitHub issue | |
| CI red only | Run goes red; rely on the Actions tab | ✓ |
| CI red + notify | CI red plus Slack/email if a webhook secret is configured | |

**User's choice:** CI red only.

---

## DSR Tenant-Delete Model

### Execution model

| Option | Description | Selected |
|--------|-------------|----------|
| Async deletion job (202) | Endpoint enqueues a job, returns 202 + status reference; CLI polls | ✓ |
| Synchronous (204) | Deletes inline, returns 204; risks timeout on large tenants | |
| Sync with size guard | Small tenants inline; large tenants rejected → async path | |

**User's choice:** Async deletion job (202).

### Audit-log handling after deletion

| Option | Description | Selected |
|--------|-------------|----------|
| Redact rows + keep deletion tombstone | Prior rows scrubbed; one un-redacted record proves the deletion | ✓ |
| Redact all rows uniformly | Every row scrubbed the same; no special deletion record | |

**User's choice:** Redact rows + keep deletion tombstone.

### Content-store blob-delete failure

| Option | Description | Selected |
|--------|-------------|----------|
| Fail loud, re-runnable | Idempotent; unrecoverable failure fails the job; re-run finishes cascade | ✓ |
| Best-effort, log + continue | Job completes; failed blobs logged for manual cleanup | |

**User's choice:** Fail loud, re-runnable.

### Portability re-import

| Option | Description | Selected |
|--------|-------------|----------|
| Real `admin tenant import` command | Ship import symmetric with export; portability test exercises real path | ✓ |
| Test-only re-import harness | Re-import lives only in tests/e2e/dsr/portability/ | |

**User's choice:** Real `admin tenant import` command.

---

## Redaction Strategy

### Detection mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: key-path + value-pattern | pino redact paths + serializer regex-scanning for secret shapes | ✓ |
| Key-path only | pino redact paths; misses secrets in message strings / unknown keys | |
| Value-pattern only | Regex-scan every payload; robust but heavier CPU, can over-redact | |

**User's choice:** Hybrid: key-path + value-pattern.

### Where redaction lives

| Option | Description | Selected |
|--------|-------------|----------|
| Shared redactor module | One redactor in @spatula/shared; all 4 sinks route through it | ✓ |
| Per-sink native config | Each sink uses its own native redaction; patterns drift over time | |

**User's choice:** Shared redactor module.

---

## Claude's Discretion

- Output-content scanner sensitivity / thresholds (prompt-echo, field-name-leakage, cap-hits).
- Redaction match-action format (`[REDACTED]` placeholder vs field drop).
- Cascade deletion ordering across entities / raw_pages / content-store / forensic blobs.
- Forensic endpoint internal pagination cursor shape (follows §3.3.5).

## Deferred Ideas

- HSTS / CSP transport headers (CONCERNS.md, `security-headers.ts`) — out of Phase 18 scope; roadmap backlog.
