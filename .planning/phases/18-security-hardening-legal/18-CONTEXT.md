# Phase 18: Security Hardening & Legal - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 18 delivers a production-grade security posture and the legal scaffolding that
lets the repo flip public:

- **Prompt-injection defense** — role separation, hardened system prompt,
  `<UNTRUSTED_CONTENT>` wrapping, Zod-validated outputs with one stricter retry,
  field allowlist, free-text length caps, output-content scanner.
- **Adversarial fixture suite** — ≥10 fixtures (10 attack classes) vs pinned models.
- **Secret/PII redaction sweep** — across stdout, file, Sentry, OTel sinks.
- **Full DSR surface** — tenant delete (cascade), export, import, rectification docs.
- **Forensic provenance** — `forensic:true` tagging + admin forensic endpoint.
- **Audit-CI hardening** — OSV + license allowlist + gitleaks/trufflehog.
- **Legal docset** — LICENSE copyright line, TRADEMARK.md, brand license, CLA,
  THIRD_PARTY_NOTICES, SECURITY.md audit, README disclaimer, abuse-contact User-Agent.

Scope is fixed by ROADMAP.md Phase 18 (SEC-01..12, LEGAL-01..08). Transport-layer
hardening (HSTS/CSP) is NOT in scope — see Deferred Ideas.

</domain>

<decisions>
## Implementation Decisions

### Legal Identity & Pre-Phase Blockers

- **D-01:** BLOCK-02 — the legal entity **is formed**. `LICENSE` copyright line reads
  `Copyright (c) 2026 Accidentally Awesome Labs`. No interim-name path, no `NOTICE.md`,
  no assignment commit. `TRADEMARK.md` names Accidentally Awesome Labs as the holder.
- **D-02:** BLOCK-06 — the USPTO TESS search has **not** been done. Phase 18 includes a
  task to run + document the TESS search for "Spatula" **before** `TRADEMARK.md` is
  finalized. Search-then-write is ordered; a surfaced conflict escalates (rename).
- **D-03:** BLOCK-09 — **solo contributor**. `.github/HISTORICAL_CONTRIBUTORS.md` is a
  one-line enumeration of the sole copyright holder. No pre-sign outreach task —
  `git log --format='%ae' | sort -u` confirms a single author.

### Adversarial Fixture Suite CI

- **D-04:** Cadence — the live-LLM adversarial suite runs on **PRs touching
  `packages/core/src/extraction/**`or`pinned-models.ts`** (or carrying a `live-llm`label), **plus a daily cron**. Not on every push. Reuses Phase 16's`SPATULA_LIVE_LLM`
  env split so contributor-fork CI passes without an OpenRouter key.
- **D-05:** Ollama lane — CI auto-runs only the **OpenRouter pin**
  (`anthropic/claude-3-5-sonnet-20240620`). The Ollama pin
  (`llama3.1:8b-instruct-q4_0`) runs via manual `workflow_dispatch` (or a self-hosted
  runner) — not pulled on GitHub-hosted runners. Both pins are committed to
  `pinned-models.ts`; the suite must be green against both.
- **D-06:** Cron-failure handling — a failed daily-cron adversarial run goes **CI-red
  only**. No auto-opened issue, no Slack/email notification wiring.

### DSR (Data Subject Rights) Surface

- **D-07:** Deletion is **async**. `DELETE /api/v1/admin/tenants/:id` enqueues a
  deletion job and returns `202` + a status reference. `spatula admin tenant delete
--tenant <id>` polls to completion.
- **D-08:** Audit log after deletion — the tenant's prior audit rows are **redacted in
  place** (PII scrubbed); **one un-redacted deletion record (tombstone)** is kept
  proving when and by whom the deletion ran. Audit rows are NOT deleted.
- **D-09:** Cascade is **idempotent + fail-loud**. A content-store blob deletion failure
  fails the job loudly; re-running safely finishes the cascade. No best-effort /
  log-and-continue — GDPR-complete deletion is the bar.
- **D-10:** Portability re-import ships as a **real product command** —
  `spatula admin tenant import` + matching admin API — symmetric with export.
  `tests/e2e/dsr/portability/` exercises the real import path, not a test-only harness.

### Secret & PII Redaction

- **D-11:** Detection is **hybrid** — pino `redact` paths for known structured fields
  (`Authorization`/`Cookie` headers, etc.) **plus** a serializer that regex-scans values
  for secret shapes (JWT, `sk-`/key prefixes, OpenRouter keys, Stripe-pattern strings).
  Catches both structured and free-text leaks.
- **D-12:** One **shared redactor module in `@spatula/shared`** — the pino serializer,
  Sentry `beforeSend`, OTel span processor, and stdout path all route through it.
  Single source of truth, single test target. `tests/shared/redaction/` verifies each
  sink independently.

### Claude's Discretion

- Output-content scanner sensitivity/thresholds (prompt-echo substring length,
  field-name-leakage matching, cap-hit flagging) — tune during implementation per
  spec §3.7.2.7.
- Redaction match-action format (`[REDACTED]` placeholder vs field drop) — placeholder
  preserves log structure; final call to the implementer.
- Cascade deletion ordering across entities / raw_pages / content-store blobs /
  forensic blobs — any order is fine within the D-09 fail-loud idempotent constraint.
- Forensic endpoint internal pagination cursor shape — follows the §3.3.5 cursor-first
  convention already established.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Security spec

- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` §3.7 —
  Prompt-injection defense: threat model (§3.7.1), 10 defense-in-depth mitigations
  (§3.7.2), forensic provenance (§3.7.3), v1 limits (§3.7.4), docs (§3.7.5).
- ↑ same spec §3.7.2 item 8 — the 10 adversarial attack classes the ≥10 fixtures must
  cover (direct injection, zero-width smuggling, fake-schema coercion, exfiltration,
  jailbreak, multi-step re-feed, HTML-comment-hidden, CSS display:none, data-URI,
  unicode confusables).
- ↑ same spec §3.8 — Secret & PII redaction: sink list, secret patterns,
  zero-telemetry boundary clarification.
- ↑ same spec §6-4 — Phase 18 deliverables list + acceptance criteria.
- ↑ same spec §3.3.11 — experimental-tag policy (governs the forensic endpoint surface).

### Legal spec

- ↑ same spec §3.9 — LICENSE line + interim fallback, TRADEMARK.md policy,
  `brand/LICENSE-BRAND.md`, THIRD_PARTY_NOTICES tool pin, CLA, README disclaimer,
  User-Agent.

### Requirements & roadmap

- `.planning/REQUIREMENTS.md` SEC-01..SEC-12 — security acceptance criteria.
- `.planning/REQUIREMENTS.md` LEGAL-01..LEGAL-08 — legal acceptance criteria.
- `.planning/REQUIREMENTS.md` BLOCK-02 / BLOCK-06 / BLOCK-09 — pre-phase gates.
- `.planning/ROADMAP.md` "### Phase 18" — goal, 6 success criteria, pre-phase gates.

### Prior phase context

- `.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md` — frozen error envelope
  (security/DSR errors use it), experimental-tag policy + `client.experimental.*` Proxy
  (forensic endpoint's home).
- `.planning/phases/17-browser-auth-sse-cors/17-CONTEXT.md` — auth scope conventions;
  `admin:forensic:read` joins the CI-gated scope table in `docs/api-auth.md`.

### Docs authored/edited this phase

- `docs/security-model.md` — full threat model + mitigations matrix (SEC-07) — **new**.
- `docs/privacy.md` — zero-telemetry boundary + self-host controller obligations
  (SEC-08) — **new**.
- `docs/api-auth.md` — existing; `admin:forensic:read` appended to its scope table
  (CI-gated by the Phase 17 `SCOPE_TABLE_START/END` markers).

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `packages/shared/src/logger.ts` — pino logger factory; **currently zero redaction**.
  The D-11/D-12 shared redactor plugs in here as pino `redact` config + serializer.
- `packages/shared/src/auth/audit-logger.ts` — existing audit-log writer; the D-08 DSR
  redaction operates on its rows and writes the deletion tombstone.
- `packages/core/src/extraction/static-extractor.ts` + `schema-to-prompt.ts` — current
  LLM extraction prompt assembly; prompt-injection mitigations (role separation,
  `<UNTRUSTED_CONTENT>` wrapping, hardened system prompt) land here. No `__tests__/`
  dir exists yet — the adversarial fixtures + `pinned-models.ts` are net-new.
- `packages/core/src/content-store/` (S3/local) + `packages/db/src/content-store/pg-content-store.ts`
  — `ContentStore` backends; `forensic:true` tagging + the DSR blob-delete cascade
  extend these.
- `packages/core/src/llm/` — model clients (openrouter/ollama) the pinned suite drives.
- `.github/workflows/audit.yml` — exists; hardened with OSV + license-allowlist +
  gitleaks/trufflehog full-history scan (SEC-11).
- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` — exist (Wave 4). Missing and net-new:
  `TRADEMARK.md`, `THIRD_PARTY_NOTICES.md`, `brand/LICENSE-BRAND.md`, `.github/CLA.md`,
  `.github/HISTORICAL_CONTRIBUTORS.md`.

### Established Patterns

- Phase 16 `SPATULA_LIVE_LLM` env gate + `it.skipIf(LIVE)` — the adversarial suite
  reuses this so contributor-fork CI passes without an OpenRouter key.
- Phase 16 experimental surface — `client.experimental` Proxy + `x-spatula-experimental:
true` OpenAPI tag — the forensic endpoint is the sole v1 experimental and slots in.
- Tenant-scoped everything — every table/query carries `tenant_id`; the DSR cascade
  walks these scopes.
- Frozen error envelope `{ error: { code, message, requestId, details? } }` (Phase 16)
  — security/DSR errors use it; error codes from `@spatula/core-types`.

### Integration Points

- New routes: `DELETE /api/v1/admin/tenants/:id`,
  `GET /api/v1/admin/forensic/extractions`, tenant import route — admin router in
  `apps/api/src`.
- New CLI commands: `spatula admin tenant delete | export | import` — CLI admin group.
- New BullMQ job kind — async tenant-delete cascade worker in `packages/queue`.
- New DLQ kind `suspicious_extraction` — extends the existing dead-letter-queue.
- `docs/api-auth.md` scope table — `admin:forensic:read` appended.

</code_context>

<specifics>
## Specific Ideas

- Pinned models verbatim: `openrouter/anthropic/claude-3-5-sonnet-20240620` and
  `ollama/llama3.1:8b-instruct-q4_0` → committed to
  `packages/core/src/extraction/__tests__/pinned-models.ts`.
- Adversarial fixtures live in `packages/core/src/extraction/__tests__/fixtures/adversarial/`.
- Forensic endpoint returns metadata + a 15-min-TTL signed URL (`contentRef`), never
  inline HTML; reachable from the SDK only via `client.experimental.forensic.*`.
- `THIRD_PARTY_NOTICES.md` auto-generated via the pinned `license-checker-rseidelsohn`
  tool, invoked by a `pnpm run generate:notices` script; regenerated per release cut.
- `brand/LICENSE-BRAND.md` text: "All rights reserved. Use per TRADEMARK.md."
- Default User-Agent: `Spatula/<version> (+https://spatula.dev/abuse)`.
- CLA via `cla-assistant.io`; CLA text versioned in `.github/CLA.md` with a `version`
  frontmatter field; re-sign-on-text-change policy documented in `CONTRIBUTING.md`.
- Redaction tests: `tests/shared/redaction/` — each sink verified independently.
- DSR e2e: `tests/e2e/dsr/deletion/` (round-trip → assert empty) and
  `tests/e2e/dsr/portability/` (dump → re-import → field-level parity).

</specifics>

<deferred>
## Deferred Ideas

- **HSTS / CSP transport headers** — `.planning/codebase/CONCERNS.md` flags
  `apps/api/src/middleware/security-headers.ts` as missing HSTS and CSP headers
  (deferred from Wave 5-6). Out of Phase 18 scope — this phase covers
  prompt-injection / redaction / DSR / legal, not transport-layer hardening. Note for
  the roadmap backlog.

No scope creep arose during discussion — all questions clarified how to implement
already-scoped requirements.

</deferred>

---

_Phase: 18-security-hardening-legal_
_Context gathered: 2026-05-20_
