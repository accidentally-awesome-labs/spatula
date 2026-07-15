# Spatula deprecation and experimental-tag policy

> Authoritative source for how Spatula introduces, ages, and removes experimental and deprecated surfaces. Cross-link target for `docs/compat-policy.md`, `docs/api-errors.md`, and `docs/api-idempotency.md`.

## v1.0 state

Spatula v1.0 ships with **one experimental surface**:

- `client.experimental.forensic.listExtractions()` → `GET /api/v1/admin/forensic/extractions`

The endpoint is tagged `x-spatula-experimental: true` in the OpenAPI document and requires `admin:forensic:read` or `admin` scope. The `client.experimental.*` namespace is fail-loud: accessing any property other than `forensic` throws an explanatory `Error`.

```typescript
import { SpatulaClient } from '@accidentally-awesome-labs/spatula-client';
const client = new SpatulaClient({ baseUrl: '...' });

await client.experimental.forensic.listExtractions({ limit: 25 });

// v1.0: throws
client.experimental.dlqAdmin;
// Error: client.experimental.dlqAdmin is not available.
```

## Experimental tag

An "experimental" surface is an endpoint, SDK method, or response field tagged `x-spatula-experimental: true` in the OpenAPI spec. Properties of experimental surfaces:

- **Access path:** Always via `client.experimental.*` in `@accidentally-awesome-labs/spatula-client`. Never under a "stable" name and never on the bare `client.*` surface. The namespace boundary IS the contract.
- **Lifetime:** **6 months MAXIMUM** per surface, measured from the date the surface lands in a released `@accidentally-awesome-labs/spatula-client` minor.
- **End-of-life rule:** After 6 months, the surface MUST be either:
  - **Graduated** — drop the `x-spatula-experimental: true` tag, drop the `client.experimental.*` namespace, become a stable v1 surface accessible directly on `client.*`. This is additive (no major bump) — old experimental call sites continue to work for one minor as a thin shim that re-routes to the stable path AND emits a `Deprecation` header.
  - **Removed** — emit `Deprecation` + `Sunset` + `Link` headers (RFC 8594) for one release cycle, then delete entirely. After deletion, calls return `410 Gone` with envelope code `JOB.NOT_FOUND` (the closest 4xx in the frozen v1 enum) + `details.reason: 'experimental-removed'`.
- **No "permanent experimental"** — the tag is a temporary holding pen, not a feature category. A surface that's been experimental for 6 months WILL be either promoted or removed; "experimental forever" is not an option.

## Deprecation headers

When a stable surface is being removed across a major bump, OR an experimental surface graduates with shape changes, OR an offset-paginated surface is being phased out, the server emits RFC 8594 headers on every response:

```http
Deprecation: Sun, 11 Nov 2026 23:59:59 GMT
Sunset: Mon, 11 May 2027 23:59:59 GMT
Link: </docs/compat-policy>; rel="successor-version"
```

- `Deprecation` — RFC 8594 date the surface entered deprecation.
- `Sunset` — date after which the surface returns `410 Gone`.
- `Link` — points to the doc explaining the migration path.

The helper that emits these is `apps/api/src/lib/deprecation-headers.ts`. v1.0 already wires it on offset-paginated routes (`GET /api/v1/jobs/:jobId/entities?offset=…`, `?extractions?offset=…`, `?exports?offset=…`, `?jobs?offset=…`). Cursor-mode requests do NOT receive deprecation headers — they hit the canonical envelope path.

## Why this matters for consumers

- **A `Deprecation` header is not an error.** Your code should keep working. Treat it as a build-time signal to schedule migration before the `Sunset` date.
- **After `Sunset`, expect `410 Gone`.** Allow for at least one client release between the Sunset header appearance and the Sunset date.
- **The `Link` rel="successor-version" target is canonical.** Follow it (or its doc-anchor) — don't reverse-engineer migration paths from the deprecated surface's shape.

## Major-version policy

Spatula follows strict semver on the three public packages: `@accidentally-awesome-labs/spatula`, `@accidentally-awesome-labs/spatula-client`, `@accidentally-awesome-labs/spatula-core-types`. The internal packages (`@accidentally-awesome-labs/spatula-core`, `@accidentally-awesome-labs/spatula-db`, `@accidentally-awesome-labs/spatula-queue`, `@accidentally-awesome-labs/spatula-shared`, `@accidentally-awesome-labs/spatula-api`) carry **no** TS-API compat guarantee — they evolve freely.

A major bump (`2.0.0`) on a public package requires ALL of the following:

1. At least one stable surface removed (vs. just deprecation).
2. A migration guide committed under `docs/migrations/`.
3. At least 6 months of overlap support — the prior major receives security fixes for 6 months from the `2.0.0` release.

The 6-month overlap is the **minimum** support window from `docs/compat-policy.md` § "Support window" — longer is allowed.

## Cross-references

- `docs/compat-policy.md` — full SDK ↔ server ↔ core-types compat matrix; the 6-month support window is defined there.
- `docs/api-errors.md` — frozen error-code enum; `410 Gone` post-Sunset envelope shape.
- `apps/api/src/lib/deprecation-headers.ts` — header helper.
- `packages/client/src/experimental/index.ts` — Proxy scaffolding.
