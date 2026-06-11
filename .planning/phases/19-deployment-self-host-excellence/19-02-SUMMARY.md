---
phase: 19-deployment-self-host-excellence
plan: "02"
subsystem: container-images
tags: [docker, distroless, hardening, supply-chain, deploy-03]
dependency_graph:
  requires: [19-01-PLAN.md]
  provides: [Dockerfile.api-distroless, Dockerfile.worker-distroless, Dockerfile.migrate, Dockerfile.cli-debian-slim, docker-compose.prod-migrate]
  affects: [Dockerfile.api, Dockerfile.worker, Dockerfile.cli, Dockerfile.migrate, docker-compose.prod.yml, apps/api/package.json, packages/queue/package.json]
tech_stack:
  added: [gcr.io/distroless/nodejs22-debian12, node:22-bookworm-slim]
  patterns: [distroless-exec-form-cmd, USER-nonroot, shamefully-hoist-prod-deps, NODE_ENV-production-default]
key_files:
  created: [Dockerfile.migrate]
  modified: [Dockerfile.api, Dockerfile.worker, Dockerfile.cli, docker-compose.prod.yml, apps/api/package.json, packages/queue/package.json, pnpm-lock.yaml]
decisions:
  - "ENV NODE_ENV=production baked into all images so the shared logger skips dev-only pino-pretty (boot crash otherwise)"
  - "--shamefully-hoist in worker + cli prod-deps so transitive runtime deps (zod) resolve at root node_modules"
  - "cli built with --filter=@spatula/cli... to exclude @spatula/client (clean isolated client build needs DOM libs — deferred)"
  - "api distroless healthcheck switched wget -> bundled node+fetch (distroless has no wget/shell)"
metrics:
  duration_min: 95
  completed: 2026-06-10
---

# Phase 19 Plan 02: Container Image Hardening Summary

Distroless api/worker/migrate (`gcr.io/distroless/nodejs22-debian12`, `USER nonroot`,
exec-form path-only CMD) + Debian-slim cli, a dedicated independently-signable
`Dockerfile.migrate` (4th image for SC#3), and a compose migrate service re-pointed at it —
all four images validated to build single-arch AND start cleanly (run past module resolution
to their expected missing-config errors).

## What was built

- **Dockerfile.api / Dockerfile.worker** — runtime stage replaced with distroless nodejs22.
  `USER nonroot` (uid 65532, no addgroup/adduser), path-only CMD (`apps/api/dist/main.js` —
  the real Plan-01 bootstrap, not the index.js barrel — and `packages/queue/dist/worker-entrypoint.js`).
  Build + prod-deps alpine stages kept.
- **Dockerfile.migrate** (new) — distroless one-shot migration runner. db-only build closure,
  runtime carries shared + core-types + db dist + the `packages/db/drizzle` SQL, CMD
  `packages/db/dist/run-migrate.js`.
- **Dockerfile.cli** — runtime → `node:22-bookworm-slim` (shell + glibc for Playwright; distroless
  would break it). Non-root `spatula` via groupadd/useradd. Playwright browsers intentionally not
  baked in (documented; in-cluster use is `spatula doctor`, whose playwright check warns not fails).
- **docker-compose.prod.yml** — migrate service now builds `Dockerfile.migrate` (no `node` command
  override). api healthcheck `wget` → bundled `node` + `fetch`.

## Validation (local, single-arch — Docker 29.3.0)

| Image | build | runtime smoke |
|-------|-------|---------------|
| api | ✅ exit 0 (370 MB) | ✅ JSON log → `ConfigError: database.url/openrouter.apiKey Required` (expected) |
| worker | ✅ exit 0 | ✅ JSON log → `ConfigError CONFIG_ERROR` (expected) |
| migrate | ✅ exit 0 | ✅ `StorageError: DATABASE_URL is required` (expected) |
| cli | ✅ exit 0 | ✅ prints `spatula <command> [options]` usage |

All 14 grep acceptance checks pass. `docker compose config` valid. Multi-arch buildx + cosign/SBOM
is Plan 19-03 (this plan is image runtime stages only, validated single-arch as the plan scopes).

## Deviations from Plan

The plan assumed "replace only the runtime stage." Reality (surfaced by actually building + running
the prod images, which the original interrupted executor never completed) required several
correctness fixes — all directly caused by the distroless/prod switch:

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing `ENV NODE_ENV=production` → boot crash.** Distroless images default to
`NODE_ENV` undefined, so the shared logger (`packages/shared/src/logger.ts`) selected the dev-only
`pino-pretty` transport, which is absent in `--prod` deps → `Error: unable to determine transport
target for "pino-pretty"` on startup. Added `ENV NODE_ENV=production` to all four images. Compose
papered over this via `env_file`, but k8s (19-04) / Render (19-05) need the image to default correctly.

**2. [Rule 1 - Bug] worker prod-deps missing `--shamefully-hoist`.** Without it, `zod` (a dep of
`@spatula/core-types`) stayed nested and the worker crashed `ERR_MODULE_NOT_FOUND: zod` from
`core-types/dist`. api already had the flag; added it to worker (and cli) for consistency.

**3. [Rule 1 - Bug] migrate runtime missing `@spatula/core-types`.** `shared/dist/error-codes.js`
imports core-types; the migrate runtime didn't copy it → `ERR_MODULE_NOT_FOUND: @spatula/core-types`.
Added core-types dist + package.json copies.

**4. [Rule 3 - Blocking] cli build compiled `@spatula/client` and failed.** Unfiltered `turbo run
build` (dependsOn ^build) built the whole graph including the public SDK, which fails a clean
isolated build (missing DOM globals + eventsource types). Switched cli to `--filter=@spatula/cli...`
(closure excludes client) and `COPY apps/ apps/` (closure includes @spatula/api, whose source must
be present). cli runtime also now copies `@spatula/db` (cli imports it at 4 sites).

**5. [Rule 1 - Bug] api distroless healthcheck used `wget`.** Distroless has no wget/shell, so the
compose healthcheck could never pass → switched to `node -e "fetch(...)"` via `/nodejs/bin/node`.

### Salvage note
A prior executor run was interrupted (terminal API connection error) mid-plan, leaving good
Dockerfile.api/worker distroless conversions + the ajv/drizzle-orm dep fixes uncommitted, alongside
unrelated band-aid edits to `@spatula/client` (reverted) and a cosmetic em-dash regression (fixed).
The good work was kept and validated; the band-aids were discarded. The client clean-build issue is
tracked in `deferred-items.md` (DEFER-19-A).

## Known Stubs

None. Traefik/caddy are out of this plan (19-08). Playwright-not-in-cli is an intentional documented
decision, not a stub.

## Self-Check: PASSED

- [x] Dockerfile.api — distroless, USER nonroot, CMD main.js — builds + runs (commit 92dd2dd)
- [x] Dockerfile.worker — distroless, --shamefully-hoist — builds + runs (commit 92dd2dd)
- [x] Dockerfile.migrate — new, distroless, core-types present — builds + runs (commit 0f6b4d4)
- [x] Dockerfile.cli — Debian-slim, filtered build — builds + prints usage (commit 0f6b4d4)
- [x] docker-compose.prod.yml — migrate→Dockerfile.migrate, node healthcheck — valid (commit 0f6b4d4)
- [x] apps/api ajv→deps, queue drizzle-orm→deps, lockfile consistent (commit 92dd2dd)
