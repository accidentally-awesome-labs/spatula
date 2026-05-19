# Phase 16: API Contract Hardening + SDK Packages - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-19
**Phase:** 16-api-contract-sdk-packages
**Areas discussed:** Sub-plan decomposition, Error-code enum design, Public packages (core-types + client shape), OpenAPI source-of-truth + contract tests

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Sub-plan decomposition | Slice 22 reqs into reviewable PRs; BLOCK-04 gating; cut-line placement | ✓ |
| Error-code enum design | Frozen enum naming, sweep scope, details field shape | ✓ |
| Public packages: core-types + client shape | Extraction boundary, ESLint rule, typed-errors, version probe | ✓ |
| OpenAPI source-of-truth + contract tests | Runtime generation strategy, drift detection, test structure | ✓ |

**Areas dropped (consolidated into 4-option limit):** config/rate-limits.yaml shape, release-please topology, SQLite benchmark gate (all routed to Claude's Discretion in CONTEXT.md).

---

## Sub-plan decomposition

### Q1: How many sub-plans to slice Phase 16 into?

| Option | Description | Selected |
|--------|-------------|----------|
| 5 sub-plans (recommended) | 16-1 envelope+rate-limit+rate-limits.yaml \| 16-2 core-types+client+size-limit \| 16-3 OpenAPI runtime+version endpoint+probe+compat-policy \| 16-4 contract tests \| 16-5 release-please+SQLite+provenance | ✓ |
| 3 sub-plans (big chunks) | Server-side / SDK / Release infra grouping | |
| 7+ sub-plans (fine-grained) | One per discrete deliverable | |

**User's choice:** 5 sub-plans (recommended)
**Notes:** Roughly 2 sessions per sub-plan; matches the 8–10 session budget.

### Q2: Where does BLOCK-04 (npm @spatula org) gate fit in?

| Option | Description | Selected |
|--------|-------------|----------|
| Gates only release sub-plan (recommended) | All code work proceeds; only final release-please dry-run + provenance publish blocks on BLOCK-04 | ✓ |
| Gates entire phase entry | Strict reading: even creating @spatula/* package.json requires resolution | |
| Gates package-naming sub-plans only | Sub-plans creating @spatula/* package.json files block on BLOCK-04 | |

**User's choice:** Gates only release sub-plan (recommended)
**Notes:** Pragmatic interpretation; allows parallel work on server sweep + package source while npm org ownership is being secured.

### Q3: PR + branch shape — carry Phase 15 pattern forward or different?

| Option | Description | Selected |
|--------|-------------|----------|
| One PR per sub-plan (recommended) | Each sub-plan = own branch + PR + merge | ✓ |
| Single phase PR like Phase 15 | One branch, all sub-plans as task commits, single merge-commit | |
| Stacked PRs per sub-plan | Sequential merge, no parallel review | |

**User's choice:** One PR per sub-plan (recommended)
**Notes:** Different from Phase 15's single-PR pattern because Phase 16 is 2–3× larger and sub-plans are more independent.

### Q4: Sequencing — what runs first / what blocks what?

| Option | Description | Selected |
|--------|-------------|----------|
| Error envelope first (recommended) | 16-1 (envelope + headers + rate-limits.yaml) first; core-types extract needs frozen enum | ✓ |
| Core-types extract first | 16-2 first so enum lives in core-types from day one | |
| Contract tests first (TDD) | Write tests/contract/ against locked-spec before sweep | |

**User's choice:** Error envelope first (recommended)
**Notes:** Order locked: 16-1 → 16-2 → 16-3 → 16-4 → 16-5.

---

## Error-code enum design

### Q1: Error-code enum naming style?

| Option | Description | Selected |
|--------|-------------|----------|
| Flat SCREAMING_SNAKE (recommended) | QUOTA_EXCEEDED, JOB_NOT_FOUND, etc.; matches existing code | |
| Category-prefixed (DOMAIN.CODE) | JOB.NOT_FOUND, EXTRACTION.QUOTA_EXCEEDED; self-documenting | ✓ |
| HTTP-status-anchored | ERR_400_VALIDATION, ERR_429_QUOTA | |

**User's choice:** Category-prefixed (DOMAIN.CODE)
**Notes:** Chosen over recommended flat style; collision avoidance valued more than typing brevity given frozen-forever + additive-only 1.x policy.

### Q2: Source-of-truth migration — how to get from current ~12 codes to frozen enum?

| Option | Description | Selected |
|--------|-------------|----------|
| Audit + curate + freeze (recommended) | Grep + enumerate + dedupe/rename + write canonical enum | |
| Start from existing, expand as needed | Take current ~12 codes verbatim, add new ones during sweep | |
| Start from scratch, derive from OpenAPI | Define ideal enum first, rewrite every error site | ✓ |

**User's choice:** Start from scratch, derive from OpenAPI
**Notes:** Most rigorous approach; avoids legacy-string baggage in a frozen-forever enum. Walk the @hono/zod-openapi registry programmatically to enumerate intended errors per route.

### Q3: Sweep scope — how aggressive is the per-route audit?

| Option | Description | Selected |
|--------|-------------|----------|
| Full audit now, contract tests enforce (recommended) | Sub-plan 16-1 visits every route + throw site; 16-4 contract tests gate drift | ✓ |
| Contract tests only | Skip manual sweep; let tests/contract/ catch failures | |
| Sample audit + tests | Spot-check ~20% manually, tests catch the rest | |

**User's choice:** Full audit now, contract tests enforce (recommended)
**Notes:** Belt AND suspenders — highest confidence for v1.0 freeze.

### Q4: `details` field shape on error envelope?

| Option | Description | Selected |
|--------|-------------|----------|
| Free-form Record<string,unknown> (recommended) | Envelope frozen; details content evolves freely per error site | ✓ |
| Per-code typed details union | Discriminated union of typed details per code | |
| Omit `details` entirely at v1.0 | Skip; add later | |

**User's choice:** Free-form Record<string,unknown> (recommended)
**Notes:** Avoids tight server↔client type coupling; lets each error site populate what's useful.

---

## Public packages: core-types + client shape

### Q1: @spatula/core-types extraction boundary — what comes out of @spatula/core?

| Option | Description | Selected |
|--------|-------------|----------|
| Types + zod + enums only (recommended) | Pure type-only exports + zod schemas + enums; zero runtime helpers | ✓ |
| Types + zod + builder helpers | Above plus thin pure-fn builders | |
| Types + zod + factories + constants | Above plus constants like DEFAULT_LIMITS | |

**User's choice:** Types + zod + enums only (recommended)
**Notes:** Matches spec §3.2.2 verbatim ("type-only exports + zod schemas"); smallest frozen surface.

### Q2: ESLint rule scope — what does the 'no runtime imports' rule actually block?

| Option | Description | Selected |
|--------|-------------|----------|
| Block all non-type imports from @spatula/core-types (recommended) | Consumer-side enforcement | ✓ |
| Block runtime imports FROM @spatula/core (into core-types) | Inverse direction | |
| Both directions | Bidirectional enforcement | |

**User's choice:** Block all non-type imports from @spatula/core-types (recommended)
**Notes:** Enforces zero-runtime-deps promise at consumer boundary; sufficient for v1.

### Q3: SDK typed-errors taxonomy?

| Option | Description | Selected |
|--------|-------------|----------|
| Class-per-code, all extend SpatulaApiError (recommended) | QuotaExceededError, JobNotFoundError, etc. via codegen | ✓ |
| Single SpatulaApiError with .code discriminator | One class; users branch on .code | |
| Hybrid: broad classes + generic fallback | Common cases get classes; rest is SpatulaApiError | |

**User's choice:** Class-per-code, all extend SpatulaApiError (recommended)
**Notes:** Most ergonomic for TS users; auto-generated via codegen from frozen enum. Committed output (not build-time).

### Q4: Version-probe trigger semantics?

| Option | Description | Selected |
|--------|-------------|----------|
| Lazy on first request (recommended) | Constructor returns immediately; first call awaits probe + throws on major mismatch | ✓ |
| Eager async on construction | Constructor fires fetch; expose await client.ready() | |
| Manual probe + stored state | Sync constructor; user calls await client.checkVersion() | |

**User's choice:** Lazy on first request (recommended)
**Notes:** Browser-friendly (SSR/RSC safe); no constructor I/O surprises.

---

## OpenAPI source-of-truth + contract tests

### Q1: OpenAPI runtime generation strategy for GET /api/v1/openapi.json?

| Option | Description | Selected |
|--------|-------------|----------|
| Generate-once-at-boot + cache (recommended) | OpenAPIHono builds registry at boot; freeze JSON in memory; serve cached | ✓ |
| Generate per request | Call getOpenAPI31Document on each hit | |
| Build-time pre-bake + import | Generate at build, commit, import as static JSON | |

**User's choice:** Generate-once-at-boot + cache (recommended)
**Notes:** Single source-of-truth (live Zod registrations); drift impossible by construction; CDN-friendly byte-identical responses.

### Q2: Drift detection mechanism — how do we prove the served OpenAPI matches actual runtime behavior?

| Option | Description | Selected |
|--------|-------------|----------|
| Contract tests roundtrip (recommended) | Fetch /openapi.json, validate every response body against schema via ajv | ✓ |
| Commit snapshot + diff in CI | Generate at build, commit openapi-snapshot.json, diff in CI | |
| Both snapshot + roundtrip | Belt-and-suspenders | |

**User's choice:** Contract tests roundtrip (recommended)
**Notes:** Catches both spec drift and runtime drift in one suite; no separate committed snapshot.

### Q3: tests/contract/ structure — how is the suite organized against 'every route, every 4xx/5xx, every example'?

| Option | Description | Selected |
|--------|-------------|----------|
| Generated from OpenAPI (recommended) | Test runner reads /openapi.json, iterates tuples, generates cases via describe.each + it.each | ✓ |
| Hand-written per route | One test file per route, manual enumeration | |
| Hybrid: generated coverage matrix + targeted assertions | Two-tier: mechanical generated + behavioral hand-written | |

**User's choice:** Generated from OpenAPI (recommended)
**Notes:** Adding a route auto-adds test coverage; matches success criterion 1 wording mechanically.

### Q4: Example validation — spec says 'every OpenAPI example validates against its schema'. How?

| Option | Description | Selected |
|--------|-------------|----------|
| ajv against generated JSON Schema at boot (recommended) | Extract examples at boot in dev; compile + validate; fail boot if off-schema | ✓ |
| ajv in contract test only | Move to tests/contract/ suite only | |
| Use zod schema directly (not via JSON Schema) | Re-parse via original zod | |

**User's choice:** ajv against generated JSON Schema at boot (recommended)
**Notes:** Dev-only boot check gives author immediate feedback; same checks re-run in CI via tests/contract/.

---

## Claude's Discretion

Areas routed to planner/researcher per CONTEXT.md `<decisions>` section:
- `config/rate-limits.yaml` shape (granularity, override mechanism, default fallback, hot-reload)
- `release-please` topology for 8 packages (single config vs per-package; lockstep enforcement)
- SQLite benchmark gate timing (sub-plan 16-5 first task; +3 sessions if switch criteria pass)
- `experimental:` tag policy machinery (ship dormant policy + namespace scaffolding; no header emission until Phase 18)
- Cursor format/algorithm (reuse Wave 3-3b composite cursor; opacity contract documentation)
- `Deprecation` + `Sunset` header format (RFC 8594; v2.0 GA sunset target)
- Internal-package no-compat notice format (single canonical template)
- Codegen pipeline for error classes (committed output; CI diff check)

## Deferred Ideas

Captured in CONTEXT.md `<deferred>` section:
- CLI migration to `@spatula/client` (Phase 16 uses client only for version probe in `spatula doctor`; full migration deferred)
- Webhook delivery rebuild (Phase 16 documents existing; rebuild in Phase 18 or v1.2)
- Idempotency replay test suite expansion (Phase 16 spot-checks only)
- OpenAPI client codegen for non-TS languages (deferred per DEFER-02)
- Standalone `docs/api-cursor.md` (deferred unless docs site Phase 20 needs it)
- `experimental:` tag header emission machinery (lands with first experimental surface in Phase 18)
- `spatula-saas` consuming-side pre-release tag automation (out of OSS scope)
</content>
</invoke>