# Spatula compatibility policy

> **Authoritative source for SDK ↔ server ↔ core-types version compatibility.**
> Cross-reference: `docs/api-errors.md` (error code enum), `docs/deprecation-policy.md` (experimental tag rules), `docs/private-contract.md` (internal-package compat carve-out for `spatula-saas`).

This document anchors the Spatula compat matrix at v1. It is the public counterpart to `docs/private-contract.md` (which covers the OSS surface consumed by the private `accidentally-awesome-labs/spatula-saas` repo). Linked from every published package README.

## Purpose

A small, frozen-at-v1 wire contract is the single most valuable thing the Spatula team can offer to consumers building anything non-trivial on the API — browser web UIs, third-party CLIs, data-platform integrations, custom orchestrators. This policy describes what is frozen, what is additive, and what is allowed to break — and on what schedule.

## Compat matrix

| Component | Compat rule |
| --- | --- |
| `@spatula/core-types` | **Frozen at v1**; additive-only in 1.x. Removing or renaming an export is a major break. |
| `@spatula/client` | **Exact-peer-dep on `@spatula/core-types` major** (lockstep via release-please `linked-versions`). The two packages publish together at the same major. |
| `@spatula/api` (server) | **REST contract frozen at v1.** Server supports the previous SDK major for **12 months** post-major-cut. Path versioning (`/api/v1/*`) is the URL contract. |
| `@spatula/cli` | Independent semver. Bundles `@spatula/client` at the matching major. May ship breaking flag changes between majors with a deprecation cycle. |
| `@spatula/core` / `db` / `queue` / `shared` | **No TS-API compat guarantee** (per `docs/private-contract.md`). Subject to silent breaking changes between minor versions. Imports from these are the consumer's risk; the SaaS-style downstream `spatula-saas` repo is the only sanctioned consumer and pins exact minor versions via its own contract tests. |

## Major-compat-within-major

- **Servers and SDKs MUST share major version** for normal operation.
- During a major bump (e.g., v1 → v2):
  - The OLD major server continues running for at least 12 months after v2.0 GA.
  - The NEW major SDK MUST refuse to talk to an old-major server (and vice versa).
- **Verification:** the SDK lazily probes `GET /.well-known/spatula-version` on first request. On mismatch, throws `SpatulaVersionMismatchError` BEFORE the user's actual request fires. See `packages/client/src/version-probe.ts`.

## Mismatch error classes

- **`SpatulaVersionMismatchError`** — server major ≠ SDK major. Thrown by the lazy probe on first `request()`. Wraps the wire envelope `{ code: 'VERSION.MISMATCH', status: 426, details: { sdkMajor, serverMajor, serverVersion } }`. Consumers should treat this as a non-retryable verdict and prompt the user to upgrade `@spatula/client` to the matching major.
- **`FeatureUnavailableError`** — SDK calls an endpoint that the connected server doesn't support (e.g., SDK v1.5 calling a v1.5-introduced endpoint on a v1.4 server). Servers respond with `426 Upgrade Required` + `code: 'VERSION.MISMATCH'`; SDK decodes to this class. Consumers MAY retry against a different server URL but should NOT retry against the same URL — the verdict is bound to the server, not the network.

## Probe behavior

- **When**: Lazy — first `client.request()` call. Constructor performs zero I/O (SSR-safe).
- **Caching**: One probe per client lifetime. The resolved promise is cached.
  - On a major-mismatch **verdict**, the rejected promise is cached — subsequent calls re-throw the same `SpatulaVersionMismatchError` without re-fetching the probe. Major versions don't change in seconds.
  - On a transient transport error (fetch reject, 5xx, timeout), the probe promise is RESET so the next call can retry. The server may come back; transient failures shouldn't permanently disable the client.
- **Failure mode**: 404 from `/.well-known/spatula-version` is treated as "unknown server" — probe degrades gracefully, the request proceeds. This is intentional for talking to non-Spatula servers in tests, or older Spatula releases that don't expose `/.well-known`.
- **Opt-out**: Pass `skipVersionProbe: true` to the `SpatulaClient` constructor. Use this in unit tests, against mocked servers, or in offline scenarios where `/.well-known` is known to be absent.

## 12-month support window

After a major bump:

- **Old-major server** continues running for ≥ 12 months. CI maintains a `release/v{N}` branch with critical-fix backports.
- **Old-major SDK** continues installing from npm (we never unpublish). Old-major-on-new-major-server returns `426 + VERSION.MISMATCH`.
- **`docs/api-errors.md` enum** for the old major remains the source of truth for that major's wire codes — additive-only changes only.

## Frozen wire shapes (v1)

The following are FROZEN — changes are MAJOR breaks:

- **Error envelope**: `{ error: { code, message, requestId, details? } }`
- **Error code namespace**: `DOMAIN.CODE` (e.g., `JOB.NOT_FOUND`, `RATE_LIMIT.EXCEEDED`, `VERSION.MISMATCH`). Adding new codes is additive (1.x-compatible). Removing or renaming is a major break.
- **Cursor pagination envelope**: `{ data, nextCursor, hasMore }`
- **Offset pagination envelope** (deprecated): `{ data, total, page, limit, hasMore }` + RFC 8594 `Deprecation` + `Sunset` + `Link rel="successor-version"` headers. Sunset target: v2.0 GA.
- **Rate-limit header set**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **URL versioning**: every public route under `/api/v1/`. The `/.well-known/spatula-version` and `/.well-known/*` family is a root-level sibling (not under `/api/v1/`) per RFC 8615.
- **Export format shapes**: JSON, CSV, Parquet, SQLite, DuckDB (5 formats frozen — see `docs/architecture.md` § "Export format stability").

## Experimental surfaces

See `docs/deprecation-policy.md`. v1.0 ships ZERO experimental surfaces. First experimental surface (admin forensic-extractions endpoint) lands in Phase 18 and is accessed via `client.experimental.forensic.*`. The `client.experimental.*` Proxy is already published as scaffolding at v1.0 — any property access throws with a message containing `'zero experimental surfaces'` and a pointer to Phase 18.

## What a consumer MAY rely on

- The wire shapes in [Frozen wire shapes (v1)](#frozen-wire-shapes-v1).
- The error-code enum in `docs/api-errors.md`.
- The `@spatula/core-types` package — types and zod schemas only, zero runtime deps (zod as peer).
- The `@spatula/client` package — `SpatulaClient` class, 4 helper methods (`createJob`, `listJobs`, `getEntities`, `getJobEvents`), 25 class-per-code typed error subclasses, ≤ 50 KB gzipped measured surface.
- The `/api/v1/openapi.json` runtime endpoint — boot-cached, byte-identical across requests; downstream tooling can fetch + cache it.
- The `/.well-known/spatula-version` endpoint shape.

## What a consumer MAY NOT rely on

- Internal TypeScript shapes from `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/api`, `@spatula/shared`. These packages publish for SaaS-style downstream consumers (per `docs/private-contract.md`) but carry **no compat guarantee** for arbitrary external imports.
- The `details` payload of any specific error code — the envelope is frozen but the `details` content evolves freely per error site as new context is added. Pattern-match on `code` (the frozen DOMAIN.CODE string), not on `details` shape.
- Pre-1.0 surfaces (`0.x` series) — these are tracking releases and may break between minors.

---

*Last reviewed: 2026-05-19 (Phase 16, plan 16-3).*
